import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ReadinessService } from '../modules/operations/readiness';
import type { HttpResponse } from './http-error.filter';

/** Explicitly public, read-only, and independent of financial authorization. */
@Controller('health')
export class HealthController {
  constructor(@Inject(ReadinessService) private readonly readiness: ReadinessService) {}
  @Get('live')
  live() { return { status: 'alive' }; }
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: HttpResponse) {
    const result = await this.readiness.check();
    response.status(result.status === 'ready' ? 200 : 503);
    return result;
  }
}
