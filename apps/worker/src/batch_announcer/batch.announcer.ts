import { Injectable, Logger } from '@nestjs/common';
import { PassThrough } from 'node:stream';
import { ParquetWriter } from '@dsnp/parquetjs';
import { fromFrequencySchema } from '@dsnp/frequency-schemas/parquet';
import { InjectRedis } from '@liaoliaots/nestjs-redis';
import Redis from 'ioredis';
import { PalletSchemasSchema } from '@polkadot/types/lookup';
import { hexToString } from '@polkadot/util';
import { BlockchainService } from '../../../../libs/common/src/blockchain/blockchain.service';
import { ConfigService } from '../../../../libs/common/src/config/config.service';
import { IBatchAnnouncerJobData } from '../interfaces/batch-announcer.job.interface';
import { IPublisherJob } from '../interfaces/publisher-job.interface';
import { IpfsService } from '../../../../libs/common/src/utils/ipfs.client';

@Injectable()
export class BatchAnnouncer {
  private logger: Logger;

  constructor(
    @InjectRedis() private cacheManager: Redis,
    private configService: ConfigService,
    private blockchainService: BlockchainService,
    private ipfsService: IpfsService,
  ) {
    this.logger = new Logger(BatchAnnouncer.name);
  }

  public async announce(batchJob: IBatchAnnouncerJobData): Promise<IPublisherJob> {
    this.logger.debug(`Announcing batch ${batchJob.batchId} on IPFS`);
    const { batchId, schemaId, announcements } = batchJob;

    const schemaCacheKey = `schema:${schemaId}`;
    let cachedSchema: string | null = await this.cacheManager.get(schemaCacheKey);
    if (!cachedSchema) {
      const schemaResponse = await this.blockchainService.getSchema(schemaId);
      cachedSchema = JSON.stringify(schemaResponse);
      await this.cacheManager.set(schemaCacheKey, cachedSchema);
    }

    const frequencySchema: PalletSchemasSchema = JSON.parse(cachedSchema);
    const hexString: string = Buffer.from(frequencySchema.model).toString('utf8');
    const schema = JSON.parse(hexToString(hexString));
    if (!schema) {
      throw new Error(`Unable to parse schema for schemaId ${schemaId}`);
    }

    const [parquetSchema, writerOptions] = fromFrequencySchema(schema);
    const publishStream = new PassThrough();
    const parquetBufferAwait = this.bufferPublishStream(publishStream);
    const writer = await ParquetWriter.openStream(parquetSchema, publishStream as any, writerOptions);
    // eslint-disable-next-line no-restricted-syntax
    for await (const announcement of announcements) {
      await writer.appendRow(announcement);
    }
    await writer.close();

    const buffer = await parquetBufferAwait;
    const [cid, hash, size] = await this.pinParquetFileToIPFS(buffer);
    const ipfsUrl = await this.formIpfsUrl(cid);
    this.logger.debug(`Batch ${batchId} published to IPFS at ${ipfsUrl}`);
    this.logger.debug(`Batch ${batchId} hash: ${hash}`);
    return { id: batchId, schemaId, data: { cid, payloadLength: size } };
  }

  private async bufferPublishStream(publishStream: PassThrough): Promise<Buffer> {
    this.logger.debug('Buffering publish stream');
    return new Promise<Buffer>((resolve, reject) => {
      const buffers: Buffer[] = [];
      publishStream.on('data', (data) => {
        buffers.push(data);
      });
      publishStream.on('end', () => {
        resolve(Buffer.concat(buffers));
      });
      publishStream.on('error', (err) => {
        reject(err);
      });
    });
  }

  private async pinParquetFileToIPFS(buf: Buffer): Promise<[string, string, number]> {
    const { cid, hash, size } = await this.ipfsService.ipfsPin('application/octet-stream', buf);
    return [cid.toString(), hash, size];
  }

  private async formIpfsUrl(cid: string): Promise<string> {
    return this.configService.getIpfsCidPlaceholder(cid);
  }
}
