import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { IsPublic } from 'src/auth/decorator/is-public.decorator';
import { LocationsService } from './locations.service';

export class LocationListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;
}

/** Public, cacheable lists for address and profile forms. */
@Controller('locations')
@UseGuards(ThrottlerGuard)
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get('countries')
  @IsPublic()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Header('Cache-Control', 'public, max-age=86400')
  countries() {
    return this.locations.listCountries();
  }

  @Get('states')
  @IsPublic()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Header('Cache-Control', 'public, max-age=86400')
  states(@Query() query: LocationListQueryDto) {
    return this.locations.listStates(query.country ?? '');
  }

  @Get('cities')
  @IsPublic()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Header('Cache-Control', 'public, max-age=86400')
  cities(@Query() query: LocationListQueryDto) {
    return this.locations.listCities(query.country ?? '', query.state ?? '');
  }
}
