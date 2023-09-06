import { Injectable, Logger } from '@nestjs/common';
import { PassThrough } from 'node:stream';
import { ParquetWriter } from '@dsnp/parquetjs';
import { fromFrequencySchema } from '@dsnp/frequency-schemas/parquet';
import {
  ActivityContentImageLink,
  ActivityContentTag,
  ActivityContentAttachment,
  ActivityContentLink,
  ActivityContentImage,
  ActivityContentVideoLink,
  ActivityContentVideo,
  ActivityContentAudio,
  ActivityContentAudioLink,
} from '@dsnp/activity-content/types';
import { BlockchainService } from '../blockchain/blockchain.service';
import { ConfigService } from '../../../api/src/config/config.service';
import { IBatchAnnouncerJobData } from '../interfaces/batch-announcer.job.interface';
import { IPublisherJob } from '../interfaces/publisher-job.interface';
import { IpfsService } from '../../../../libs/common/src/utils/ipfs.client';
import { calculateDsnpHash } from '../../../../libs/common/src/utils/ipfs';
import { TagTypeDto, AttachmentTypeDto, AssetDto } from '../../../../libs/common/src';
import { createNote } from '../../../../libs/common/src/interfaces/dsnp';

@Injectable()
export class IpfsAnnouncer {
  private logger: Logger;

  constructor(
    private configService: ConfigService,
    private blockchainService: BlockchainService,
    private ipfsService: IpfsService,
  ) {
    this.logger = new Logger(IpfsAnnouncer.name);
  }

  public async announce(batchJob: IBatchAnnouncerJobData): Promise<IPublisherJob> {
    this.logger.debug(`Announcing batch ${batchJob.batchId} on IPFS`);
    const { batchId, schemaId, announcements } = batchJob;

    const frequencySchema = await this.blockchainService.getSchema(schemaId);
    const schema = JSON.parse(frequencySchema.model.toString());
    if (!schema) {
      throw new Error(`Unable to parse schema for schemaId ${schemaId}`);
    }

    const [parquetSchema, writerOptions] = fromFrequencySchema(schema);
    const publishStream = new PassThrough();

    const writer = await ParquetWriter.openStream(parquetSchema, publishStream as any, writerOptions);

    announcements.forEach(async (announcement) => {
      writer.appendRow(announcement);
    });

    await writer.close();
    const buffer = await this.bufferPublishStream(publishStream);
    const [cid, hash] = await this.pinStringToIPFS(buffer);
    const ipfsUrl = await this.formIpfsUrl(cid);
    this.logger.debug(`Batch ${batchId} published to IPFS at ${ipfsUrl}`);
    this.logger.debug(`Batch ${batchId} hash: ${hash}`);
    return { id: batchId, schemaId, data: { cid, payloadLength: buffer.length } };
  }

  private async bufferPublishStream(publishStream: PassThrough): Promise<Buffer> {
    this.logger.debug('Buffering publish stream');
    return new Promise((resolve, reject) => {
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

  public async prepareNote(noteContent?: any): Promise<[string, string, string]> {
    this.logger.debug(`Preparing note`);
    const tags: ActivityContentTag[] = [];
    if (noteContent?.content.tag) {
      noteContent.content.tag.forEach((tag) => {
        switch (tag.type) {
          case TagTypeDto.Hashtag:
            tags.push({ name: tag.name || '' });
            break;
          case TagTypeDto.Mention:
            tags.push({
              name: tag.name || '',
              type: 'Mention',
              id: tag.mentionedId || '',
            });
            break;
          default:
            throw new Error(`Unsupported tag type ${typeof tag.type}`);
        }
      });
    }

    const attachments: ActivityContentAttachment[] = [];
    if (noteContent?.content.assets) {
      noteContent.content.assets.forEach(async (asset: AssetDto) => {
        switch (asset.type) {
          case AttachmentTypeDto.LINK: {
            const link: ActivityContentLink = {
              type: 'Link',
              href: asset.href || '',
              name: asset.name || '',
            };

            attachments.push(link);
            break;
          }
          case AttachmentTypeDto.IMAGE: {
            const imageLinks: ActivityContentImageLink[] = [];
            asset.references?.forEach(async (reference) => {
              const contentBuffer = await this.ipfsService.getPinned(reference.referenceId);
              const hashedContent = await calculateDsnpHash(contentBuffer);
              const image: ActivityContentImageLink = {
                mediaType: 'image', // TODO
                hash: [hashedContent],
                height: reference.height,
                width: reference.width,
                type: 'Link',
                href: await this.formIpfsUrl(reference.referenceId),
              };
              imageLinks.push(image);
            });
            const imageActivity: ActivityContentImage = {
              type: 'Image',
              name: asset.name || '',
              url: imageLinks,
            };

            attachments.push(imageActivity);
            break;
          }
          case AttachmentTypeDto.VIDEO: {
            const videoLinks: ActivityContentVideoLink[] = [];
            let duration = '';
            asset.references?.forEach(async (reference) => {
              const contentBuffer = await this.ipfsService.getPinned(reference.referenceId);
              const hashedContent = await calculateDsnpHash(contentBuffer);
              const video: ActivityContentVideoLink = {
                mediaType: 'video', // TODO
                hash: [hashedContent],
                height: reference.height,
                width: reference.width,
                type: 'Link',
                href: await this.formIpfsUrl(reference.referenceId),
              };
              duration = reference.duration ?? '';
              videoLinks.push(video);
            });
            const videoActivity: ActivityContentVideo = {
              type: 'Video',
              name: asset.name || '',
              url: videoLinks,
              duration,
            };

            attachments.push(videoActivity);
            break;
          }
          case AttachmentTypeDto.AUDIO: {
            const audioLinks: ActivityContentAudioLink[] = [];
            let duration = '';
            asset.references?.forEach(async (reference) => {
              const contentBuffer = await this.ipfsService.getPinned(reference.referenceId);
              const hashedContent = await calculateDsnpHash(contentBuffer);
              duration = reference.duration ?? '';
              const audio: ActivityContentAudioLink = {
                mediaType: 'audio', // TODO
                hash: [hashedContent],
                type: 'Link',
                href: await this.formIpfsUrl(reference.referenceId),
              };
              audioLinks.push(audio);
            });
            const audioActivity: ActivityContentAudio = {
              type: 'Audio',
              name: asset.name || '',
              url: audioLinks,
              duration,
            };

            attachments.push(audioActivity);
            break;
          }
          default:
            throw new Error(`Unsupported attachment type ${typeof asset.type}`);
        }
      });
    }

    const note = createNote(noteContent?.content.content ?? '', new Date(noteContent?.content.published ?? ''), {
      name: noteContent?.content.name,
      location: {
        latitude: noteContent?.content.location?.latitude,
        longitude: noteContent?.content.location?.longitude,
        radius: noteContent?.content.location?.radius,
        altitude: noteContent?.content.location?.altitude,
        accuracy: noteContent?.content.location?.accuracy,
        name: noteContent?.content.location?.name || '',
        type: 'Place',
      },
      tag: tags,
      attachment: attachments,
    });
    const noteString = JSON.stringify(note);
    const [cid, hash] = await this.pinStringToIPFS(Buffer.from(noteString));
    const ipfsUrl = await this.formIpfsUrl(cid);
    return [cid, hash, ipfsUrl];
  }

  private async pinStringToIPFS(buf: Buffer): Promise<[string, string]> {
    const { cid, size } = await this.ipfsService.ipfsPin('application/octet-stream', buf);
    return [cid.toString(), size.toString()];
  }

  private async formIpfsUrl(cid: string): Promise<string> {
    return this.configService.getIpfsCidPlaceholder(cid);
  }
}
