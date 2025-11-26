import { Injectable, OnModuleInit } from '@nestjs/common';
import { createWorker } from 'mediasoup';
import { Router, Worker, AppData } from 'mediasoup/node/lib/types';

@Injectable()
export class MediasoupService implements OnModuleInit {
  worker: Worker<AppData>;
  router: Router<AppData>;
  transports = new Map();
  producers = new Map();
  consumers = new Map();
  userTransports = new Map();

  async onModuleInit() {
    this.worker = await createWorker({
      rtcMinPort: parseInt(process.env.RTC_MIN_PORT) || 40000,
      rtcMaxPort: parseInt(process.env.RTC_MAX_PORT) || 49999,
    });

    this.router = await this.worker.createRouter({
      mediaCodecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
          parameters: {
            'sprop-stereo': 1,
            'stereo': 1,
            'useinbandfec': 1, // Forward error correction
            'usedtx': 0, // Disable discontinuous transmission
          },
        },
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: {
            'x-google-start-bitrate': 1000,
          },
        },
        {
          kind: 'video',
          mimeType: 'video/VP9',
          clockRate: 90000,
          parameters: {
            'profile-id': 2,
            'x-google-start-bitrate': 1000,
          },
        },
        {
          kind: 'video',
          mimeType: 'video/h264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '4d0032',
            'level-asymmetry-allowed': 1,
            'x-google-start-bitrate': 1000,
          },
        },
      ],
    });

    console.log('Mediasoup worker + router ready');
  }

  getRtpCapabilities() {
    return this.router.rtpCapabilities;
  }

  async createWebRtcTransport(clientId: string) {
    const announcedIp = process.env.ANNOUNCED_IP || '127.0.0.1';
    
    const transport = await this.router.createWebRtcTransport({
      listenIps: [{ ip: '0.0.0.0', announcedIp }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1000000,
    });

    this.transports.set(transport.id, transport);

    // keep track of client transports
    if (!this.userTransports.has(clientId)) {
      this.userTransports.set(clientId, {});
    }

    console.log('Transport created with ICE candidates:', transport.iceCandidates);

    return transport;
  }
}
