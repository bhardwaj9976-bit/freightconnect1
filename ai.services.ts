// apps/backend/src/modules/ai/ai.service.ts
// AI-powered route optimization, dynamic pricing engine, and ETA prediction

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { Booking } from '../booking/entities/booking.entity';
import { DriverLocation } from '../tracking/entities/driver-location.entity';

interface PricingInput {
  distance_km: number;
  weight_kg: number;
  vehicle_type: string;
  pickup_time: Date;
  pickup_lat: number;
  pickup_lng: number;
  delivery_lat: number;
  delivery_lng: number;
}

interface ETAInput {
  distance_km: number;
  vehicle_type: string;
  pickup_time: Date;
  pickup_lat: number;
  pickup_lng: number;
  current_lat?: number;
  current_lng?: number;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly GOOGLE_MAPS_KEY: string;

  constructor(
    @InjectRepository(Booking) private bookingRepo: Repository<Booking>,
    @InjectRepository(DriverLocation) private locationRepo: Repository<DriverLocation>,
    @InjectRedis() private redis: Redis,
    private configService: ConfigService,
  ) {
    this.GOOGLE_MAPS_KEY = configService.get('GOOGLE_MAPS_KEY');
  }

  // ─── Dynamic Pricing Engine ───────────────────────────────────────────────
  // Multi-factor pricing: base rate + distance + weight + demand + time-of-day + fuel index

  async getDynamicPricing(input: PricingInput) {
    const cacheKey = this.buildPricingCacheKey(input);
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const [demandFactor, fuelIndex, tollEstimate, trafficFactor] = await Promise.all([
      this.getDemandFactor(input.pickup_lat, input.pickup_lng, input.pickup_time),
      this.getFuelIndex(),
      this.estimateTolls(input.pickup_lat, input.pickup_lng, input.delivery_lat, input.delivery_lng),
      this.getTrafficFactor(input.pickup_lat, input.pickup_lng, input.pickup_time),
    ]);

    // Base rates per vehicle type (INR per km)
    const BASE_RATES: Record<string, number> = {
      mini_truck: 18,
      truck: 28,
      trailer: 45,
      container: 55,
      tanker: 50,
      refrigerated: 65,
    };

    const baseRatePerKm = BASE_RATES[input.vehicle_type] || 28;
    const distanceCost = baseRatePerKm * input.distance_km;

    // Weight surcharge: ₹0.8 per kg above 5T
    const weightSurcharge = input.weight_kg > 5000 ? (input.weight_kg - 5000) * 0.0008 * 1000 : 0;

    // Minimum distance cost for short hauls
    const minimumCharge = 800;
    const baseCost = Math.max(distanceCost + weightSurcharge, minimumCharge);

    // Apply multipliers
    const adjustedCost = baseCost * demandFactor * fuelIndex * trafficFactor;

    // Time-of-day adjustment
    const hour = input.pickup_time.getHours();
    const peakHours = (hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 20);
    const timeMultiplier = peakHours ? 1.15 : 1.0;

    const finalBaseRate = Math.round(adjustedCost * timeMultiplier);

    const nearby_vehicle_count = await this.getNearbyAvailableVehicles(input.pickup_lat, input.pickup_lng, input.vehicle_type);

    const result = {
      base_rate: finalBaseRate,
      toll_estimate: tollEstimate,
      breakdown: {
        distance_cost: Math.round(distanceCost),
        weight_surcharge: Math.round(weightSurcharge),
        demand_multiplier: demandFactor,
        fuel_index: fuelIndex,
        traffic_factor: trafficFactor,
        time_multiplier: timeMultiplier,
        peak_hours: peakHours,
      },
      nearby_vehicle_count,
    };

    // Cache for 5 minutes
    await this.redis.setex(cacheKey, 300, JSON.stringify(result));
    return result;
  }

  // ─── ETA Prediction ───────────────────────────────────────────────────────

  async predictETA(input: ETAInput): Promise<number> {
    // Use Google Distance Matrix API for real-time traffic-aware ETA
    const origin = `${input.current_lat ?? input.pickup_lat},${input.current_lng ?? input.pickup_lng}`;

    try {
      const response = await axios.get('https://maps.googleapis.com/maps/api/distancematrix/json', {
        params: {
          origins: origin,
          destinations: `${input.pickup_lat},${input.pickup_lng}`,
          departure_time: Math.floor(input.pickup_time.getTime() / 1000),
          traffic_model: 'best_guess',
          key: this.GOOGLE_MAPS_KEY,
        },
        timeout: 5000,
      });

      const element = response.data.rows[0]?.elements[0];
      if (element?.status === 'OK') {
        // Return ETA in minutes with vehicle-type speed adjustment
        const baseSeconds = element.duration_in_traffic?.value || element.duration.value;
        const speedFactor = this.getVehicleSpeedFactor(input.vehicle_type);
        return Math.round((baseSeconds * speedFactor) / 60);
      }
    } catch (e) {
      this.logger.warn(`Google Maps ETA failed, using distance-based estimate: ${e.message}`);
    }

    // Fallback: distance-based estimate
    const avgSpeedKmh = this.getAverageSpeed(input.vehicle_type, input.pickup_time);
    return Math.round((input.distance_km / avgSpeedKmh) * 60);
  }

  // ─── Route Optimization ───────────────────────────────────────────────────
  // For multi-stop deliveries using Google Directions API + nearest-neighbor TSP heuristic

  async optimizeRoute(stops: Array<{ lat: number; lng: number; address: string }>): Promise<{
    optimized_order: number[];
    total_distance_km: number;
    total_duration_minutes: number;
    route_coords: Array<{ latitude: number; longitude: number }>;
  }> {
    if (stops.length <= 2) {
      return { optimized_order: stops.map((_, i) => i), total_distance_km: 0, total_duration_minutes: 0, route_coords: [] };
    }

    // Simple nearest-neighbor TSP for <= 10 stops
    // For production: use Google OR-Tools or a dedicated TSP service
    const optimizedOrder = this.nearestNeighborTSP(stops);

    const waypoints = optimizedOrder
      .slice(1, -1)
      .map(i => `${stops[i].lat},${stops[i].lng}`)
      .join('|');

    try {
      const response = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
        params: {
          origin: `${stops[optimizedOrder[0]].lat},${stops[optimizedOrder[0]].lng}`,
          destination: `${stops[optimizedOrder[optimizedOrder.length - 1]].lat},${stops[optimizedOrder[optimizedOrder.length - 1]].lng}`,
          waypoints: waypoints ? `optimize:false|${waypoints}` : undefined,
          departure_time: 'now',
          traffic_model: 'best_guess',
          key: this.GOOGLE_MAPS_KEY,
        },
        timeout: 10000,
      });

      if (response.data.status === 'OK') {
        const route = response.data.routes[0];
        const totalDistance = route.legs.reduce((sum: number, leg: any) => sum + leg.distance.value, 0) / 1000;
        const totalDuration = route.legs.reduce((sum: number, leg: any) => sum + (leg.duration_in_traffic?.value || leg.duration.value), 0) / 60;

        // Decode polyline
        const routeCoords = this.decodePolyline(route.overview_polyline.points);

        return {
          optimized_order: optimizedOrder,
          total_distance_km: Math.round(totalDistance * 10) / 10,
          total_duration_minutes: Math.round(totalDuration),
          route_coords: routeCoords,
        };
      }
    } catch (e) {
      this.logger.error('Route optimization failed', e);
    }

    return { optimized_order: optimizedOrder, total_distance_km: 0, total_duration_minutes: 0, route_coords: [] };
  }

  // ─── Demand Forecasting ───────────────────────────────────────────────────

  async forecastDemand(lat: number, lng: number, date: Date): Promise<{
    demand_level: 'low' | 'medium' | 'high' | 'surge';
    demand_score: number;
    peak_hours: number[];
    recommended_pickup_time: Date;
  }> {
    // Query historical bookings for this area and time window
    const historicalData = await this.bookingRepo
      .createQueryBuilder('b')
      .select([
        'EXTRACT(HOUR FROM b.pickup_time) as hour',
        'COUNT(*) as count',
      ])
      .where(
        `ST_DWithin(
          ST_MakePoint(b.pickup_lng, b.pickup_lat)::geography,
          ST_MakePoint(:lng, :lat)::geography,
          20000
        )`,
        { lat, lng }
      )
      .andWhere('b.created_at > NOW() - INTERVAL \'30 days\'')
      .groupBy('hour')
      .orderBy('count', 'DESC')
      .getRawMany();

    const hourlyDemand = historicalData.map(r => ({ hour: parseInt(r.hour), count: parseInt(r.count) }));
    const maxCount = Math.max(...hourlyDemand.map(h => h.count), 1);
    const currentHourData = hourlyDemand.find(h => h.hour === date.getHours());
    const demandScore = currentHourData ? (currentHourData.count / maxCount) : 0.5;

    const demand_level = demandScore > 0.8 ? 'surge' : demandScore > 0.6 ? 'high' : demandScore > 0.3 ? 'medium' : 'low';
    const peakHours = hourlyDemand.filter(h => h.count > maxCount * 0.7).map(h => h.hour);

    // Recommend off-peak time
    const offPeakHour = hourlyDemand.find(h => h.count < maxCount * 0.4)?.hour ?? 10;
    const recommendedTime = new Date(date);
    recommendedTime.setHours(offPeakHour, 0, 0, 0);

    return { demand_level, demand_score: Math.round(demandScore * 100) / 100, peak_hours: peakHours, recommended_pickup_time: recommendedTime };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async getDemandFactor(lat: number, lng: number, time: Date): Promise<number> {
    const { demand_score } = await this.forecastDemand(lat, lng, time);
    // Surge: up to 1.5x on high demand
    return 1.0 + (demand_score * 0.5);
  }

  private async getFuelIndex(): Promise<number> {
    const cached = await this.redis.get('fuel:index');
    if (cached) return parseFloat(cached);
    // In production: fetch from fuel price API
    const fuelIndex = 1.05; // 5% above baseline
    await this.redis.setex('fuel:index', 3600, fuelIndex.toString());
    return fuelIndex;
  }

  private async estimateTolls(lat1: number, lng1: number, lat2: number, lng2: number): Promise<number> {
    // Simplified toll estimation based on distance
    const distance = this.haversine(lat1, lng1, lat2, lng2);
    return Math.round(distance * 2.5); // ₹2.5 per km average toll
  }

  private async getTrafficFactor(lat: number, lng: number, time: Date): Promise<number> {
    const hour = time.getHours();
    const isWeekend = [0, 6].includes(time.getDay());
    if (isWeekend) return 1.0;
    if ((hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 19)) return 1.1;
    return 1.0;
  }

  private async getNearbyAvailableVehicles(lat: number, lng: number, vehicleType: string): Promise<number> {
    const key = `vehicles:nearby:${vehicleType}:${Math.round(lat * 10)}:${Math.round(lng * 10)}`;
    const cached = await this.redis.get(key);
    if (cached) return parseInt(cached);
    // Simplified estimate — in production query drivers table
    const count = Math.floor(Math.random() * 8) + 2;
    await this.redis.setex(key, 60, count.toString());
    return count;
  }

  private getVehicleSpeedFactor(vehicleType: string): number {
    const factors: Record<string, number> = {
      mini_truck: 1.0, truck: 1.1, trailer: 1.2,
      container: 1.2, tanker: 1.15, refrigerated: 1.1,
    };
    return factors[vehicleType] ?? 1.1;
  }

  private getAverageSpeed(vehicleType: string, time: Date): number {
    const hour = time.getHours();
    const isPeak = (hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 20);
    const baseSpeeds: Record<string, number> = {
      mini_truck: 55, truck: 50, trailer: 45, container: 45, tanker: 48,
    };
    const base = baseSpeeds[vehicleType] ?? 50;
    return isPeak ? base * 0.7 : base;
  }

  private nearestNeighborTSP(stops: Array<{ lat: number; lng: number }>): number[] {
    const n = stops.length;
    const visited = new Array(n).fill(false);
    const order = [0];
    visited[0] = true;

    for (let i = 1; i < n; i++) {
      const current = order[order.length - 1];
      let nearestDist = Infinity;
      let nearest = -1;

      for (let j = 0; j < n; j++) {
        if (!visited[j]) {
          const dist = this.haversine(stops[current].lat, stops[current].lng, stops[j].lat, stops[j].lng);
          if (dist < nearestDist) { nearestDist = dist; nearest = j; }
        }
      }

      if (nearest !== -1) { order.push(nearest); visited[nearest] = true; }
    }

    return order;
  }

  private haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private decodePolyline(encoded: string): Array<{ latitude: number; longitude: number }> {
    const points: Array<{ latitude: number; longitude: number }> = [];
    let index = 0, lat = 0, lng = 0;

    while (index < encoded.length) {
      let shift = 0, result = 0, b: number;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : result >> 1;

      shift = 0; result = 0;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : result >> 1;

      points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
    }

    return points;
  }

  private buildPricingCacheKey(input: PricingInput): string {
    const roundedLat1 = Math.round(input.pickup_lat * 100) / 100;
    const roundedLng1 = Math.round(input.pickup_lng * 100) / 100;
    const hour = input.pickup_time.getHours();
    return `pricing:${input.vehicle_type}:${Math.round(input.distance_km)}:${Math.round(input.weight_kg / 1000)}:${roundedLat1}:${roundedLng1}:${hour}`;
  }
}
