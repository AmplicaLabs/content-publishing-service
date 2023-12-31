import { RequestTypeDto } from '../dtos/announcement.dto';
import { AnnouncementTypeDto } from '../dtos/common.dto';

export interface IRequestJob {
  id: string;
  announcementType: AnnouncementTypeDto;
  dsnpUserId: string;
  assetToMimeType?: Map<string, string>;
  content?: RequestTypeDto;
  dependencyAttempt: number;
}
