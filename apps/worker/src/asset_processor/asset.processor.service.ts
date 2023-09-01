import { InjectRedis } from '@liaoliaots/nestjs-redis';
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import Redis from 'ioredis';
import { ConfigService } from '../../../api/src/config/config.service';
import { QueueConstants } from '../../../../libs/common/src';
import { IAssetJob } from '../../../../libs/common/src/interfaces/asset-job.interface';

@Injectable()
@Processor(QueueConstants.ASSET_QUEUE_NAME)
export class AssetProcessorService extends WorkerHost {
  private logger: Logger;

  constructor(
    @InjectRedis() private redis: Redis,
    private configService: ConfigService,
  ) {
    super();
    this.logger = new Logger(this.constructor.name);
  }

  async process(job: Job<IAssetJob, any, string>): Promise<any> {
    this.logger.log(`Processing job ${job.id} of type ${job.name}`);
    this.logger.debug(job.asJSON());
    const redisResults = await this.redis.getBuffer(job.data.contentLocation);
    this.logger.log(redisResults?.length);
    // TODO: publish ipfs
  }

  // eslint-disable-next-line class-methods-use-this
  @OnWorkerEvent('completed')
  async onCompleted(job: Job<IAssetJob, any, string>) {
    this.logger.log(`completed ${job.id}`);
    const secondsPassed = Math.round((Date.now() - job.timestamp) / 1000);
    const expectedSecondsToExpire = 5 * 60; // TODO: get from config
    const secondsToExpire = Math.max(0, expectedSecondsToExpire - secondsPassed);
    const result = await this.redis.pipeline().del(job.data.contentLocation).expire(job.data.metadataLocation, secondsToExpire, 'LT').exec();
    this.logger.debug(result);
  }
}
