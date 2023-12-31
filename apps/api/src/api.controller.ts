import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Logger, Param, ParseFilePipeBuilder, Post, Put, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes } from '@nestjs/swagger';
import { ApiService } from './api.service';
import {
  AnnouncementResponseDto,
  AnnouncementTypeDto,
  AssetIncludedRequestDto,
  BroadcastDto,
  DSNP_VALID_MIME_TYPES,
  DsnpUserIdParam,
  FilesUploadDto,
  ProfileDto,
  ReactionDto,
  ReplyDto,
  TombstoneDto,
  UpdateDto,
  UploadResponseDto,
} from '../../../libs/common/src';

@Controller('api')
export class ApiController {
  private readonly logger: Logger;

  constructor(private apiService: ApiService) {
    this.logger = new Logger(this.constructor.name);
  }

  // eslint-disable-next-line class-methods-use-this
  @Get('health')
  health() {
    return {
      status: HttpStatus.OK,
    };
  }

  @Put('asset/upload')
  @UseInterceptors(FilesInterceptor('files'))
  @HttpCode(202)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Asset files',
    type: FilesUploadDto,
  })
  async assetUpload(
    @UploadedFiles(
      new ParseFilePipeBuilder()
        .addFileTypeValidator({
          fileType: DSNP_VALID_MIME_TYPES,
        })
        // TODO: add a validator to check overall uploaded size
        .addMaxSizeValidator({
          // this is in bytes (2 GB)
          maxSize: parseInt(process.env.FILE_UPLOAD_MAX_SIZE_IN_BYTES!, 10),
        })
        .build({
          errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        }),
    )
    files: // eslint-disable-next-line no-undef
    Array<Express.Multer.File>,
  ): Promise<UploadResponseDto> {
    return this.apiService.addAssets(files);
  }

  @Post('content/:userDsnpId/broadcast')
  @HttpCode(202)
  async broadcast(@Param() userDsnpId: DsnpUserIdParam, @Body() broadcastDto: BroadcastDto): Promise<AnnouncementResponseDto> {
    const metadata = await this.apiService.validateAssetsAndFetchMetadata(broadcastDto as AssetIncludedRequestDto);
    return this.apiService.enqueueRequest(AnnouncementTypeDto.BROADCAST, userDsnpId.userDsnpId, broadcastDto, metadata);
  }

  @Post('content/:userDsnpId/reply')
  @HttpCode(202)
  async reply(@Param() userDsnpId: DsnpUserIdParam, @Body() replyDto: ReplyDto): Promise<AnnouncementResponseDto> {
    const metadata = await this.apiService.validateAssetsAndFetchMetadata(replyDto as AssetIncludedRequestDto);
    return this.apiService.enqueueRequest(AnnouncementTypeDto.REPLY, userDsnpId.userDsnpId, replyDto, metadata);
  }

  @Post('content/:userDsnpId/reaction')
  @HttpCode(202)
  async reaction(@Param() userDsnpId: DsnpUserIdParam, @Body() reactionDto: ReactionDto): Promise<AnnouncementResponseDto> {
    return this.apiService.enqueueRequest(AnnouncementTypeDto.REACTION, userDsnpId.userDsnpId, reactionDto);
  }

  @Put('content/:userDsnpId')
  @HttpCode(202)
  async update(@Param() userDsnpId: DsnpUserIdParam, @Body() updateDto: UpdateDto): Promise<AnnouncementResponseDto> {
    const metadata = await this.apiService.validateAssetsAndFetchMetadata(updateDto as AssetIncludedRequestDto);
    return this.apiService.enqueueRequest(AnnouncementTypeDto.UPDATE, userDsnpId.userDsnpId, updateDto, metadata);
  }

  @Delete('content/:userDsnpId')
  @HttpCode(202)
  async delete(@Param() userDsnpId: DsnpUserIdParam, @Body() tombstoneDto: TombstoneDto): Promise<AnnouncementResponseDto> {
    return this.apiService.enqueueRequest(AnnouncementTypeDto.TOMBSTONE, userDsnpId.userDsnpId, tombstoneDto);
  }

  @Put('profile/:userDsnpId')
  @HttpCode(202)
  async profile(@Param() userDsnpId: DsnpUserIdParam, @Body() profileDto: ProfileDto): Promise<AnnouncementResponseDto> {
    const metadata = await this.apiService.validateAssetsAndFetchMetadata(profileDto as AssetIncludedRequestDto);
    return this.apiService.enqueueRequest(AnnouncementTypeDto.PROFILE, userDsnpId.userDsnpId, profileDto, metadata);
  }
}
