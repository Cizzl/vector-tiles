import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { RangeResponse, Source } from "pmtiles";

export class S3Source implements Source {
  constructor(
    private client: S3Client,
    private bucket: string,
    private key: string,
  ) {}

  getKey(): string {
    return this.key;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
        Range: `bytes=${offset}-${offset + length - 1}`,
      }),
    );
    const data = await res.Body!.transformToByteArray();
    return { data: data.slice().buffer as ArrayBuffer };
  }
}
