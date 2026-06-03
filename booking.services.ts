// apps/backend/src/modules/booking/booking.service.ts
// Handles full shipment lifecycle: quote → confirm → assign → track → deliver

import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Booking } from './entities/booking.entity';
import { Driver } from '../driver/entities/driver.entity';
import { Vehicle } from '../fleet/entities/vehicle.entity';
import { AiService } from '../ai/ai.service';
import { NotificationService } from '../notification/notification.service';
import { CreateBookingDto, FreightQuoteDto, AssignDriverDto, UpdateStatusDto } from './dto';
import { BookingStatus } from './enums/booking-status.enum';
import { DriverStatus } from '../driver/enums/driver-status.enum';
import { generateTrackingId } from '../../common/utils/generate-tracking-id';

@Injectable()
export class BookingService {
  constructor(
    @InjectRepository(Booking) private bookingRepo: Repository<Booking>,
    @InjectRepository(Driver) private driverRepo: Repository<Driver>,
    @InjectRepository(Vehicle) private vehicleRepo: Repository<Vehicle>,
    @InjectQueue('booking') private bookingQueue: Queue,
    @InjectQueue('notification') private notifQueue: Queue,
    private aiService: AiService,
    private notifService: NotificationService,
    private eventEmitter: EventEmitter2,
    private dataSource: DataSource,
  ) {}

  // ─── Freight Quote ────────────────────────────────────────────────────────

  async getFreightQuote(dto: FreightQuoteDto) {
    const {
      pickup_lat, pickup_lng, delivery_lat, delivery_lng,
      cargo_weight_kg, vehicle_type, pickup_time,
    } = dto;

    // Calculate distance using Haversine formula
    const distanceKm = this.calculateDistance(
      pickup_lat, pickup_lng, delivery_lat, delivery_lng,
    );

    // AI-powered dynamic pricing
    const pricingFactors = await this.aiService.getDynamicPricing({
      distance_km: distanceKm,
      weight_kg: cargo_weight_kg,
      vehicle_type,
      pickup_time: new Date(pickup_time),
      pickup_lat, pickup_lng,
      delivery_lat, delivery_lng,
    });

    const baseAmount = pricingFactors.base_rate;
    const gstAmount = baseAmount * 0.18;   // 18% GST
    const totalAmount = baseAmount + gstAmount + pricingFactors.toll_estimate;

    // Predict ETA using AI model
    const etaMinutes = await this.aiService.predictETA({
      distance_km: distanceKm,
      vehicle_type,
      pickup_time: new Date(pickup_time),
      pickup_lat, pickup_lng,
    });

    return {
      distance_km: Math.round(distanceKm * 10) / 10,
      base_amount: Math.round(baseAmount * 100) / 100,
      gst_amount: Math.round(gstAmount * 100) / 100,
      toll_estimate: pricingFactors.toll_estimate,
      total_amount: Math.round(totalAmount * 100) / 100,
      eta_minutes: etaMinutes,
      pricing_breakdown: pricingFactors.breakdown,
      valid_until: new Date(Date.now() + 30 * 60 * 1000), // 30 min validity
      available_vehicles: pricingFactors.nearby_vehicle_count,
    };
  }

  // ─── Create Booking ───────────────────────────────────────────────────────

  async create(customerId: string, dto: CreateBookingDto): Promise<Booking> {
    // Validate quote freshness
    if (new Date(dto.quote_valid_until) < new Date()) {
      throw new BadRequestException('Freight quote has expired. Please get a new quote.');
    }

    const tracking_id = generateTrackingId();  // e.g. SHP-20847

    const booking = await this.dataSource.transaction(async (manager) => {
      const newBooking = manager.create(Booking, {
        tracking_id,
        customer_id: customerId,
        status: BookingStatus.CONFIRMED,
        pickup_address: dto.pickup_address,
        pickup_lat: dto.pickup_lat,
        pickup_lng: dto.pickup_lng,
        delivery_address: dto.delivery_address,
        delivery_lat: dto.delivery_lat,
        delivery_lng: dto.delivery_lng,
        cargo_type: dto.cargo_type,
        cargo_weight_kg: dto.cargo_weight_kg,
        vehicle_type: dto.vehicle_type,
        base_amount: dto.base_amount,
        gst_amount: dto.gst_amount,
        toll_amount: dto.toll_amount,
        freight_amount: dto.freight_amount,
        pickup_time: new Date(dto.pickup_time),
      });

      const saved = await manager.save(newBooking);

      // Save multi-stop locations if provided
      if (dto.stops?.length > 0) {
        const stops = dto.stops.map((stop, index) => ({
          booking_id: saved.id,
          sequence: index + 1,
          address: stop.address,
          latitude: stop.latitude,
          longitude: stop.longitude,
          contact_name: stop.contact_name,
          contact_phone: stop.contact_phone,
        }));
        await manager.getRepository('DeliveryStop').save(stops);
      }

      return saved;
    });

    // Queue smart driver matching
    await this.bookingQueue.add('match-driver', {
      booking_id: booking.id,
      pickup_lat: dto.pickup_lat,
      pickup_lng: dto.pickup_lng,
      vehicle_type: dto.vehicle_type,
      pickup_time: dto.pickup_time,
    }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });

    // Notify customer
    await this.notifQueue.add('send', {
      user_id: customerId,
      title: 'Booking Confirmed!',
      body: `Your shipment ${tracking_id} is confirmed. Finding a driver...`,
      data: { type: 'booking_confirmed', booking_id: booking.id },
    });

    this.eventEmitter.emit('booking.created', booking);
    return booking;
  }

  // ─── Smart Driver Matching ────────────────────────────────────────────────

  async matchDriver(bookingId: string, pickupLat: number, pickupLng: number, vehicleType: string): Promise<void> {
    const booking = await this.bookingRepo.findOne({ where: { id: bookingId } });
    if (!booking) return;

    // Find available drivers near pickup using PostGIS
    const nearbyDrivers = await this.driverRepo
      .createQueryBuilder('d')
      .innerJoin('d.latest_location', 'loc')
      .where('d.status = :status', { status: DriverStatus.AVAILABLE })
      .andWhere('d.vehicle_type = :vehicleType', { vehicleType })
      .andWhere(
        `ST_DWithin(
          ST_MakePoint(loc.longitude, loc.latitude)::geography,
          ST_MakePoint(:lng, :lat)::geography,
          :radius
        )`,
        { lat: pickupLat, lng: pickupLng, radius: 50000 } // 50km radius
      )
      .orderBy(
        `d.performance_score DESC, 
         ST_Distance(
           ST_MakePoint(loc.longitude, loc.latitude)::geography,
           ST_MakePoint(:lng, :lat)::geography
         )`,
      )
      .setParameters({ lat: pickupLat, lng: pickupLng })
      .limit(5)
      .getMany();

    if (nearbyDrivers.length === 0) {
      // Expand search radius and retry via queue
      await this.bookingQueue.add('match-driver-expanded', { booking_id: bookingId, radius: 100000 }, { delay: 30000 });
      return;
    }

    // Send job offer to top driver
    const topDriver = nearbyDrivers[0];
    await this.notifService.sendToUser(topDriver.user_id, {
      title: '🚛 New load offer!',
      body: `${booking.cargo_type} · ${Math.round(booking.distance_km)}km · ₹${booking.freight_amount.toLocaleString('en-IN')}`,
      data: { type: 'job_offer', booking_id: bookingId, expires_in: 90 }, // 90s to respond
    });

    // Queue timeout — offer next driver if no response
    await this.bookingQueue.add(
      'offer-timeout',
      { booking_id: bookingId, driver_id: topDriver.id, next_candidates: nearbyDrivers.slice(1).map(d => d.id) },
      { delay: 90 * 1000 }
    );
  }

  // ─── Accept/Reject Job ────────────────────────────────────────────────────

  async acceptJob(driverId: string, bookingId: string): Promise<Booking> {
    return this.dataSource.transaction(async (manager) => {
      const booking = await manager.findOne(Booking, {
        where: { id: bookingId, status: BookingStatus.CONFIRMED },
        lock: { mode: 'pessimistic_write' },
      });

      if (!booking) throw new NotFoundException('Booking not available or already taken');

      const driver = await manager.findOne(Driver, { where: { user_id: driverId } });
      if (!driver || driver.status !== DriverStatus.AVAILABLE) {
        throw new ForbiddenException('Driver is not available');
      }

      // Update booking
      await manager.update(Booking, bookingId, {
        driver_id: driverId,
        vehicle_id: driver.vehicle_id,
        status: BookingStatus.DRIVER_ASSIGNED,
      });

      // Update driver status
      await manager.update(Driver, driver.id, { status: DriverStatus.ON_TRIP });

      const updated = await manager.findOne(Booking, { where: { id: bookingId } });

      // Notify customer
      await this.notifQueue.add('send', {
        user_id: booking.customer_id,
        title: 'Driver assigned!',
        body: `Your driver is on the way to pickup. Track live in the app.`,
        data: { type: 'driver_assigned', booking_id: bookingId, driver_id: driverId },
      });

      this.eventEmitter.emit('booking.driver_assigned', updated);
      return updated;
    });
  }

  // ─── Status Updates ───────────────────────────────────────────────────────

  async updateStatus(bookingId: string, userId: string, dto: UpdateStatusDto): Promise<Booking> {
    const booking = await this.bookingRepo.findOne({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');

    const allowed = this.getAllowedTransitions(booking.status);
    if (!allowed.includes(dto.status)) {
      throw new BadRequestException(`Cannot transition from ${booking.status} to ${dto.status}`);
    }

    await this.bookingRepo.update(bookingId, {
      status: dto.status,
      ...(dto.status === BookingStatus.DELIVERED && { delivered_at: new Date() }),
    });

    // Log tracking event
    await this.dataSource.getRepository('TrackingEvent').save({
      booking_id: bookingId,
      event_type: 'status_change',
      status: dto.status,
      latitude: dto.latitude,
      longitude: dto.longitude,
      metadata: dto.metadata,
    });

    // Broadcast via WebSocket
    this.eventEmitter.emit('booking.status_updated', {
      booking_id: bookingId,
      customer_id: booking.customer_id,
      status: dto.status,
    });

    return this.bookingRepo.findOne({ where: { id: bookingId } });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371; // Earth radius km
    const dLat = this.toRad(lat2 - lat1);
    const dLng = this.toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private toRad = (deg: number) => deg * (Math.PI / 180);

  private getAllowedTransitions(current: BookingStatus): BookingStatus[] {
    const transitions: Record<BookingStatus, BookingStatus[]> = {
      [BookingStatus.DRAFT]: [BookingStatus.CONFIRMED, BookingStatus.CANCELLED],
      [BookingStatus.CONFIRMED]: [BookingStatus.DRIVER_ASSIGNED, BookingStatus.CANCELLED],
      [BookingStatus.DRIVER_ASSIGNED]: [BookingStatus.PICKUP_EN_ROUTE, BookingStatus.CANCELLED],
      [BookingStatus.PICKUP_EN_ROUTE]: [BookingStatus.PICKED_UP],
      [BookingStatus.PICKED_UP]: [BookingStatus.IN_TRANSIT],
      [BookingStatus.IN_TRANSIT]: [BookingStatus.OUT_FOR_DELIVERY],
      [BookingStatus.OUT_FOR_DELIVERY]: [BookingStatus.DELIVERED, BookingStatus.DISPUTED],
      [BookingStatus.DELIVERED]: [],
      [BookingStatus.CANCELLED]: [],
      [BookingStatus.DISPUTED]: [BookingStatus.DELIVERED, BookingStatus.CANCELLED],
    };
    return transitions[current] || [];
  }

  async findByTrackingId(trackingId: string): Promise<Booking> {
    const booking = await this.bookingRepo.findOne({
      where: { tracking_id: trackingId },
      relations: ['driver', 'vehicle', 'delivery_stops', 'tracking_events'],
    });
    if (!booking) throw new NotFoundException(`Booking ${trackingId} not found`);
    return booking;
  }

  async getCustomerHistory(customerId: string, page = 1, limit = 20) {
    const [bookings, total] = await this.bookingRepo.findAndCount({
      where: { customer_id: customerId },
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { bookings, total, page, limit, pages: Math.ceil(total / limit) };
  }
}
