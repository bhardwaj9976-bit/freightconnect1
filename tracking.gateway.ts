// apps/backend/src/modules/tracking/tracking.gateway.ts
// WebSocket gateway for real-time GPS tracking and live updates

import {
  WebSocketGateway, WebSocketServer, SubscribeMessage,
  OnGatewayConnection, OnGatewayDisconnect, ConnectedSocket,
  MessageBody, WsException,
} from '@nestjs/websockets';
import { UseGuards, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Server, Socket } from 'socket.io';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { WsJwtGuard } from '../../common/guards/ws-jwt.guard';
import { DriverLocation } from './entities/driver-location.entity';
import { TrackingService } from './tracking.service';

interface LocationPayload {
  booking_id?: string;
  latitude: number;
  longitude: number;
  speed_kmh?: number;
  heading?: number;
  accuracy_m?: number;
  battery_pct?: number;
  timestamp: string;
}

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/tracking',
  transports: ['websocket', 'polling'],
})
export class TrackingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(TrackingGateway.name);

  // Map: userId → socketId (for targeted broadcasts)
  private userSockets = new Map<string, string>();

  constructor(
    @InjectRepository(DriverLocation) private locationRepo: Repository<DriverLocation>,
    @InjectRedis() private redis: Redis,
    private jwtService: JwtService,
    private configService: ConfigService,
    private trackingService: TrackingService,
  ) {}

  // ─── Connection Lifecycle ─────────────────────────────────────────────────

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth.token || client.handshake.headers.authorization?.split(' ')[1];
      if (!token) throw new WsException('No authentication token');

      const payload = await this.jwtService.verifyAsync(token, {
        secret: this.configService.get('JWT_SECRET'),
      });

      client.data.userId = payload.sub;
      client.data.role = payload.role;
      this.userSockets.set(payload.sub, client.id);

      // Restore active subscriptions from Redis
      const activeBookings = await this.redis.smembers(`user:${payload.sub}:tracking`);
      for (const bookingId of activeBookings) {
        client.join(`booking:${bookingId}`);
      }

      this.logger.log(`Client connected: ${client.id} (user: ${payload.sub})`);
    } catch (err) {
      this.logger.warn(`Rejected connection: ${err.message}`);
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket) {
    if (client.data.userId) {
      this.userSockets.delete(client.data.userId);

      // Mark driver as temporarily offline (with grace period)
      if (client.data.role === 'driver') {
        await this.redis.setex(`driver:${client.data.userId}:disconnected`, 60, '1');
      }
    }
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  // ─── Driver → Server: GPS Update ─────────────────────────────────────────

  @SubscribeMessage('location:update')
  async handleLocationUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: LocationPayload,
  ) {
    const driverId = client.data.userId;
    if (client.data.role !== 'driver') throw new WsException('Only drivers can update location');

    const { latitude, longitude, speed_kmh, heading, accuracy_m, battery_pct, booking_id } = payload;

    // Persist to TimescaleDB (async, don't block WS)
    this.locationRepo.save({
      driver_id: driverId,
      latitude, longitude, speed_kmh, heading, accuracy_m, battery_pct,
      booking_id,
      geom: () => `ST_MakePoint(${longitude}, ${latitude})`,
      time: new Date(payload.timestamp),
    }).catch(e => this.logger.error('Location persist error', e));

    // Cache latest position in Redis (TTL 5 min)
    await this.redis.setex(
      `driver:${driverId}:location`,
      300,
      JSON.stringify({ latitude, longitude, speed_kmh, heading, updated_at: payload.timestamp }),
    );

    // Broadcast to all customers tracking this booking
    if (booking_id) {
      this.server.to(`booking:${booking_id}`).emit('driver:location', {
        driver_id: driverId,
        latitude, longitude, speed_kmh, heading,
        timestamp: payload.timestamp,
      });

      // Check geofences asynchronously
      this.trackingService.checkGeofences(driverId, booking_id, latitude, longitude)
        .catch(e => this.logger.error('Geofence check error', e));

      // Update ETA prediction every 2 minutes
      const lastEtaKey = `booking:${booking_id}:last_eta_calc`;
      const lastCalc = await this.redis.get(lastEtaKey);
      if (!lastCalc || Date.now() - parseInt(lastCalc) > 120000) {
        await this.redis.set(lastEtaKey, Date.now());
        this.trackingService.updateETA(booking_id, latitude, longitude)
          .then(eta => {
            this.server.to(`booking:${booking_id}`).emit('eta:updated', { booking_id, eta });
          })
          .catch(e => this.logger.error('ETA update error', e));
      }
    }

    // Broadcast driver heartbeat to fleet owner and admin rooms
    this.server.to(`fleet:${driverId}`).emit('driver:heartbeat', {
      driver_id: driverId, latitude, longitude, speed_kmh, timestamp: payload.timestamp,
    });
  }

  // ─── Customer → Server: Subscribe to Booking ─────────────────────────────

  @SubscribeMessage('tracking:subscribe')
  async handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { booking_id: string },
  ) {
    const { booking_id } = data;
    const userId = client.data.userId;

    // Verify user has access to this booking
    const hasAccess = await this.trackingService.userHasBookingAccess(userId, booking_id);
    if (!hasAccess) throw new WsException('Access denied to this booking');

    client.join(`booking:${booking_id}`);
    await this.redis.sadd(`user:${userId}:tracking`, booking_id);
    await this.redis.expire(`user:${userId}:tracking`, 86400);

    // Send last known driver location immediately
    const driverId = await this.trackingService.getBookingDriverId(booking_id);
    if (driverId) {
      const cached = await this.redis.get(`driver:${driverId}:location`);
      if (cached) {
        client.emit('driver:location', { driver_id: driverId, ...JSON.parse(cached) });
      }
    }

    this.logger.log(`User ${userId} subscribed to booking ${booking_id}`);
    return { subscribed: true, booking_id };
  }

  @SubscribeMessage('tracking:unsubscribe')
  async handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { booking_id: string },
  ) {
    client.leave(`booking:${data.booking_id}`);
    await this.redis.srem(`user:${client.data.userId}:tracking`, data.booking_id);
    return { unsubscribed: true };
  }

  // ─── Server → Clients: Event Broadcasts ──────────────────────────────────

  @OnEvent('booking.status_updated')
  handleBookingStatusUpdated(data: { booking_id: string; customer_id: string; status: string }) {
    this.server.to(`booking:${data.booking_id}`).emit('booking:status', data);
  }

  @OnEvent('booking.driver_assigned')
  handleDriverAssigned(booking: any) {
    // Notify the customer's socket directly
    const socketId = this.userSockets.get(booking.customer_id);
    if (socketId) {
      this.server.to(socketId).emit('booking:driver_assigned', {
        booking_id: booking.id,
        driver_id: booking.driver_id,
      });
    }
  }

  @OnEvent('geofence.alert')
  handleGeofenceAlert(data: { booking_id: string; alert_type: string; location: any }) {
    this.server.to(`booking:${data.booking_id}`).emit('geofence:alert', data);
    // Broadcast to admin room
    this.server.to('admin:operations').emit('geofence:alert', data);
  }

  // ─── Admin: Fleet-wide Broadcast ─────────────────────────────────────────

  @SubscribeMessage('admin:join-fleet-room')
  handleJoinFleetRoom(@ConnectedSocket() client: Socket) {
    if (!['admin', 'ops_manager'].includes(client.data.role)) {
      throw new WsException('Insufficient permissions');
    }
    client.join('admin:operations');
    return { joined: 'admin:operations' };
  }

  // Get all driver locations for fleet map (admin)
  @SubscribeMessage('admin:fleet-snapshot')
  async handleFleetSnapshot(@ConnectedSocket() client: Socket) {
    if (!['admin', 'ops_manager'].includes(client.data.role)) {
      throw new WsException('Insufficient permissions');
    }

    const driverKeys = await this.redis.keys('driver:*:location');
    const snapshot = await Promise.all(
      driverKeys.map(async (key) => {
        const driverId = key.split(':')[1];
        const data = await this.redis.get(key);
        return data ? { driver_id: driverId, ...JSON.parse(data) } : null;
      }),
    );

    return { drivers: snapshot.filter(Boolean) };
  }
}
