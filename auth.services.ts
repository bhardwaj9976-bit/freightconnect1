// apps/backend/src/modules/auth/auth.service.ts
// Production-ready auth service with OTP, JWT, and Google OAuth

import { Injectable, UnauthorizedException, BadRequestException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { Twilio } from 'twilio';
import { User } from './entities/user.entity';
import { OtpCode } from './entities/otp-code.entity';
import { AuthCredential } from './entities/auth-credential.entity';
import { Wallet } from '../payment/entities/wallet.entity';
import { SendOtpDto, VerifyOtpDto, LoginDto, RegisterDto, GoogleAuthDto } from './dto';
import { UserRole } from './enums/user-role.enum';

@Injectable()
export class AuthService {
  private twilioClient: Twilio;

  constructor(
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(OtpCode) private otpRepo: Repository<OtpCode>,
    @InjectRepository(AuthCredential) private credRepo: Repository<AuthCredential>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private dataSource: DataSource,
  ) {
    this.twilioClient = new Twilio(
      configService.get('TWILIO_SID'),
      configService.get('TWILIO_TOKEN'),
    );
  }

  // ─── OTP Authentication ───────────────────────────────────────────────────

  async sendOtp(dto: SendOtpDto): Promise<{ message: string }> {
    const { phone } = dto;

    // Rate limiting — max 3 OTPs per phone per 10 minutes
    const recentOtps = await this.otpRepo
      .createQueryBuilder('otp')
      .where('otp.phone = :phone', { phone })
      .andWhere('otp.created_at > NOW() - INTERVAL \'10 minutes\'')
      .getCount();

    if (recentOtps >= 3) {
      throw new BadRequestException('Too many OTP requests. Please wait 10 minutes.');
    }

    // Invalidate previous OTPs
    await this.otpRepo.update({ phone, used: false }, { used: true });

    // Generate 6-digit OTP
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    await this.otpRepo.save({ phone, code, expires_at: expiresAt });

    // In production, send via Twilio
    if (this.configService.get('NODE_ENV') === 'production') {
      await this.twilioClient.messages.create({
        body: `Your FreightOS OTP is ${code}. Valid for 5 minutes.`,
        from: this.configService.get('TWILIO_FROM'),
        to: phone,
      });
    } else {
      console.log(`[DEV] OTP for ${phone}: ${code}`);
    }

    return { message: 'OTP sent successfully' };
  }

  async verifyOtp(dto: VerifyOtpDto): Promise<{ token: string; refreshToken: string; user: Partial<User>; isNewUser: boolean }> {
    const { phone, code } = dto;

    const otp = await this.otpRepo.findOne({
      where: { phone, code, used: false },
      order: { created_at: 'DESC' },
    });

    if (!otp || new Date() > otp.expires_at) {
      throw new UnauthorizedException('Invalid or expired OTP');
    }

    // Mark OTP as used
    await this.otpRepo.update(otp.id, { used: true });

    // Find or create user
    let user = await this.userRepo.findOne({ where: { phone } });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      await this.dataSource.transaction(async (manager) => {
        user = await manager.save(User, {
          phone,
          role: dto.role || UserRole.CUSTOMER,
          is_active: true,
        });

        // Create wallet for new user
        await manager.save(Wallet, {
          user_id: user.id,
          balance: 0,
          currency: 'INR',
        });
      });
    }

    await this.userRepo.update(user.id, { last_login_at: new Date() });

    const tokens = await this.generateTokens(user);
    return { ...tokens, user: this.sanitizeUser(user), isNewUser };
  }

  // ─── Google OAuth ─────────────────────────────────────────────────────────

  async googleAuth(dto: GoogleAuthDto): Promise<{ token: string; refreshToken: string; user: Partial<User>; isNewUser: boolean }> {
    const { idToken } = dto;

    // Verify Google ID token (use google-auth-library in production)
    const googlePayload = await this.verifyGoogleToken(idToken);

    let user = await this.userRepo.findOne({ where: { email: googlePayload.email } });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      await this.dataSource.transaction(async (manager) => {
        user = await manager.save(User, {
          email: googlePayload.email,
          full_name: googlePayload.name,
          avatar_url: googlePayload.picture,
          role: UserRole.CUSTOMER,
          is_active: true,
        });

        await manager.save(AuthCredential, {
          user_id: user.id,
          provider: 'google',
          provider_id: googlePayload.sub,
        });

        await manager.save(Wallet, { user_id: user.id, balance: 0 });
      });
    } else {
      // Ensure credential exists
      const cred = await this.credRepo.findOne({ where: { user_id: user.id, provider: 'google' } });
      if (!cred) {
        await this.credRepo.save({ user_id: user.id, provider: 'google', provider_id: googlePayload.sub });
      }
    }

    await this.userRepo.update(user.id, { last_login_at: new Date() });
    const tokens = await this.generateTokens(user);
    return { ...tokens, user: this.sanitizeUser(user), isNewUser };
  }

  // ─── Token Management ─────────────────────────────────────────────────────

  async generateTokens(user: User): Promise<{ token: string; refreshToken: string }> {
    const payload = { sub: user.id, role: user.role, phone: user.phone };

    const [token, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get('JWT_SECRET'),
        expiresIn: '24h',
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get('JWT_REFRESH_SECRET'),
        expiresIn: '30d',
      }),
    ]);

    // Store refresh token hash in auth credentials
    const hash = await bcrypt.hash(refreshToken, 10);
    await this.credRepo.upsert(
      { user_id: user.id, provider: 'local', refresh_token: hash },
      ['user_id', 'provider'],
    );

    return { token, refreshToken };
  }

  async refreshTokens(userId: string, refreshToken: string) {
    const cred = await this.credRepo.findOne({ where: { user_id: userId, provider: 'local' } });
    if (!cred?.refresh_token) throw new UnauthorizedException('Access denied');

    const rtMatches = await bcrypt.compare(refreshToken, cred.refresh_token);
    if (!rtMatches) throw new UnauthorizedException('Invalid refresh token');

    const user = await this.userRepo.findOne({ where: { id: userId } });
    return this.generateTokens(user);
  }

  async logout(userId: string): Promise<void> {
    await this.credRepo.update({ user_id: userId, provider: 'local' }, { refresh_token: null });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async verifyGoogleToken(idToken: string): Promise<any> {
    const { OAuth2Client } = await import('google-auth-library');
    const client = new OAuth2Client(this.configService.get('GOOGLE_CLIENT_ID'));
    const ticket = await client.verifyIdToken({
      idToken,
      audience: this.configService.get('GOOGLE_CLIENT_ID'),
    });
    return ticket.getPayload();
  }

  private sanitizeUser(user: User): Partial<User> {
    const { ...safe } = user;
    return safe;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// apps/backend/src/modules/auth/auth.controller.ts
// ─────────────────────────────────────────────────────────────────────────────

import { Controller, Post, Body, UseGuards, Get, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';

@ApiTags('auth')
@Controller('auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('otp/send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send OTP to phone number' })
  sendOtp(@Body() dto: SendOtpDto) {
    return this.authService.sendOtp(dto);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify OTP and get JWT tokens' })
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  @Public()
  @Post('google')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate with Google ID token' })
  googleAuth(@Body() dto: GoogleAuthDto) {
    return this.authService.googleAuth(dto);
  }

  @Public()
  @UseGuards(JwtRefreshGuard)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  refreshTokens(@Req() req) {
    return this.authService.refreshTokens(req.user.sub, req.user.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  logout(@CurrentUser() user) {
    return this.authService.logout(user.id);
  }

  @Get('me')
  @ApiBearerAuth()
  getMe(@CurrentUser() user) {
    return user;
  }
}
