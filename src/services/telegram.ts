import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram/tl";
import mongoose from "mongoose";

const API_ID = 36237198;
const API_HASH = "52b771886a88d8152f0d275898308e7f";
const SESSION_STRING =
  "1AQAOMTQ5LjE1NC4xNzUuNTgBu483aXOlclPg1q4XyxCR+s4reNbnNPfJdjQcWsqqRCJEHu8h8TpEE8tQkgqcfQfVgUllwPIeXdKfqvpqycxalHNdhQbk4BlLhXS4SachxqrBvVBO28jJhdsBjBDa9VDk5zxRRWnbmDVIZewanLPnbfOb5AlGMPGCzqz/sbotuI6eoyOskF+Qwo898U3M/RWWE3hlbTMVSHqqciumApM4Yw4FpvM1zXTUEV+WrvaQztCQxBT8LbesxM5Xps236q3pP1WLx8GZ/7LisWQkG0qQsSsxxV3ej4CMU+TQ0aaSMxbLKqwyzUDHqJAlglv+WKQHH4xJwD09UPrTRgOi4ea/Ulw=";

interface ProxySettings {
  proxyType: "http" | "socks5" | "mtproto" | "none";
  proxyHost: string;
  proxyPort: number;
  proxyUsername?: string;
  proxyPassword?: string;
  proxySecret?: string;
}

export interface AudioFile {
  messageId: number;
  title: string;
  artist: string;
  duration: number;
  fileId: string;
  fileSize: number;
  mimeType: string;
  messageDate: number;
  fileUrl: string;
  thumbnail?: string | null;
}

class TelegramService {
  private client: TelegramClient | null = null;
  private currentProxyConfig: ProxySettings | null = null;

  private async getProxySettings(userId: any): Promise<ProxySettings | null> {
    try {
      const db = mongoose.connection.db;
      const settings = await db
        .collection("user_proxy_settings")
        .findOne({ userId: userId.toString() });
      return settings as unknown as ProxySettings | null;
    } catch (error) {
      console.error("Error fetching proxy settings:", error);
      return null;
    }
  }

  private createProxyConfig(settings: ProxySettings): any {
    if (settings.proxyType === "http") {
      const auth = settings.proxyUsername
        ? `${settings.proxyUsername}:${settings.proxyPassword}@`
        : "";
      return {
        type: "http",
        url: `http://${auth}${settings.proxyHost}:${settings.proxyPort}`,
      };
    } else if (settings.proxyType === "socks5") {
      return {
        socksType: 5,
        ip: settings.proxyHost,
        port: settings.proxyPort,
        username: settings.proxyUsername || undefined,
        password: settings.proxyPassword || undefined,
      };
    } else if (settings.proxyType === "mtproto") {
      return {
        ip: settings.proxyHost,
        port: settings.proxyPort,
        MTProxy: true,
        secret: settings.proxySecret,
      };
    }
    return null;
  }

  private hasProxyChanged(newSettings: ProxySettings | null): boolean {
    return JSON.stringify(this.currentProxyConfig) !== JSON.stringify(newSettings);
  }

  async initialize(userId?: any): Promise<TelegramClient> {
    const proxySettings = userId ? await this.getProxySettings(userId) : null;

    if (this.client && !this.hasProxyChanged(proxySettings)) {
      return this.client;
    }

    if (this.client) {
      try {
        await this.client.disconnect();
      } catch {}
      this.client = null;
    }

    const session = new StringSession(SESSION_STRING);
    const clientOptions: any = { connectionRetries: 5, useWSS: false };

    if (proxySettings && proxySettings.proxyType !== "none") {
      const proxyConfig = this.createProxyConfig(proxySettings);
      if (proxyConfig) {
        if (proxySettings.proxyType === "http") {
          try {
            const { HttpsProxyAgent } = require("https-proxy-agent");
            clientOptions.agent = new HttpsProxyAgent(proxyConfig.url);
          } catch (e) {
            console.warn("https-proxy-agent not available");
          }
        } else {
          clientOptions.proxy = proxyConfig;
        }
      }
    }

    this.client = new TelegramClient(session, API_ID, API_HASH, clientOptions);
    this.currentProxyConfig = proxySettings;
    await this.client.connect();
    return this.client;
  }

  private async getDocumentThumbnail(
    doc: any,
    channelUsername: string,
    messageId: number
  ): Promise<string | null> {
    try {
      if (!doc.thumbs || doc.thumbs.length === 0) return null;

      let bestThumb = doc.thumbs[doc.thumbs.length - 1];
      if (
        bestThumb.className === "PhotoStrippedSize" &&
        doc.thumbs.length > 1
      ) {
        bestThumb = doc.thumbs[doc.thumbs.length - 2];
      }

      try {
        const thumbLocation = new Api.InputDocumentFileLocation({
          id: doc.id,
          accessHash: doc.accessHash,
          fileReference: doc.fileReference,
          thumbSize: bestThumb.type || "x",
        });
        const buffer = await this.client!.downloadFile(thumbLocation, {
          dcId: doc.dcId,
        });
        if (buffer && buffer.length > 0) {
          return `data:image/jpeg;base64,${buffer.toString("base64")}`;
        }
      } catch (error: any) {
        console.warn("Primary thumbnail download failed:", error.message);
      }

      try {
        const username = channelUsername.replace("@", "");
        const entity = await this.client!.getEntity(username);
        const messages = await this.client!.getMessages(entity, {
          ids: messageId,
        });
        if (messages[0] && messages[0].media) {
          const buffer = (await this.client!.downloadMedia(
            messages[0].media,
            {}
          )) as Buffer;
          if (buffer && buffer.length > 0) {
            return `data:image/jpeg;base64,${buffer.toString("base64")}`;
          }
        }
      } catch (error: any) {
        console.warn("Fallback thumbnail download failed:", error.message);
      }

      return null;
    } catch (error) {
      console.error("Failed to download thumbnail:", error);
      return null;
    }
  }

  async getChannelAudioFiles(
    channelUsername: string,
    userId?: any,
    lastMessageId: number = 0
  ): Promise<{ success: boolean; files?: AudioFile[]; error?: string }> {
    try {
      await this.initialize(userId);
      const username = channelUsername.replace("@", "");
      const entity = await this.client!.getEntity(username);

      const audioFiles: AudioFile[] = [];
      let offsetId = 0;
      let reachedEnd = false;

      console.log(
        `🔄 Starting ${lastMessageId > 0 ? "incremental" : "full"} sync for ${username}...`
      );

      // ── FIX: proper loop with outer break flag ──────────────
      while (!reachedEnd) {
        const messages = await this.client!.getMessages(entity, {
          limit: 100,
          offsetId,
          filter: new Api.InputMessagesFilterMusic(),
        });

        if (messages.length === 0) {
          // No more messages from Telegram
          reachedEnd = true;
          break;
        }

        for (const msg of messages) {
          // ── FIX: for incremental sync, stop when we hit already-seen msgs ──
          if (lastMessageId > 0 && msg.id <= lastMessageId) {
            reachedEnd = true; // signal outer while to stop
            break;             // break inner for
          }

          if (!msg.media || msg.media.className !== "MessageMediaDocument") {
            continue;
          }

          const doc = (msg.media as any).document;
          if (!doc) continue;

          const attributes = doc.attributes || [];
          let title = "Unknown";
          let artist = "Unknown";
          let duration = 0;

          for (const attr of attributes) {
            if (attr.className === "DocumentAttributeAudio") {
              title = attr.title || "Unknown";
              artist = attr.performer || "Unknown";
              duration = attr.duration || 0;
            }
          }

          audioFiles.push({
            messageId: msg.id,
            title,
            artist,
            duration,
            fileId: doc.id.toString(),
            fileSize: Number(doc.size) || 0,
            mimeType: doc.mimeType || "audio/mpeg",
            messageDate: msg.date,
            fileUrl: `https://t.me/${username}/${msg.id}`,
            thumbnail: null,
          });
        }

        if (reachedEnd) break;

        // Advance the offset to the last message in this batch
        offsetId = messages[messages.length - 1].id;

        // Small delay to avoid hitting Telegram rate limits on large channels
        await new Promise((r) => setTimeout(r, 300));
      }

      console.log(`✅ Fetched ${audioFiles.length} audio files from ${username}`);
      return { success: true, files: audioFiles };
    } catch (error: any) {
      console.error("Telegram Error:", error);
      return { success: false, error: error.message || "Unknown error" };
    }
  }

  async downloadFile(
    fileId: string,
    channelUsername: string,
    messageId: number,
    userId?: any,
    onProgress?: (
      progress: number,
      downloaded: number,
      total: number
    ) => void
  ): Promise<{ success: boolean; buffer?: Buffer; error?: string }> {
    try {
      await this.initialize(userId);
      const username = channelUsername.replace("@", "");
      const entity = await this.client!.getEntity(username);
      const message = await this.client!.getMessages(entity, {
        ids: messageId,
      });

      if (!message[0] || !message[0].media) {
        return { success: false, error: "File not found" };
      }

      const buffer = (await this.client!.downloadMedia(message[0].media, {
        progressCallback: (downloaded: any, total: any) => {
          const d = Number(downloaded),
            t = Number(total);
          if (t > 0 && onProgress) onProgress(Math.round((d / t) * 100), d, t);
        },
      })) as Buffer;

      return { success: true, buffer };
    } catch (error: any) {
      return { success: false, error: error.message || "Download failed" };
    }
  }

  async testConnection(
    userId?: any
  ): Promise<{ success: boolean; msg: string }> {
    try {
      await this.initialize(userId);
      await this.client!.getMe();
      return { success: true, msg: "Connection successful" };
    } catch (error: any) {
      return { success: false, msg: error.message || "Connection failed" };
    }
  }

  async getChannelPhoto(
    channelUsername: string,
    userId?: any
  ): Promise<string | null> {
    try {
      await this.initialize(userId);
      const username = channelUsername.replace("@", "");
      const entity = await this.client!.getEntity(username);
      if ((entity as any).photo) {
        const buffer = (await this.client!.downloadProfilePhoto(
          entity
        )) as Buffer;
        if (buffer && buffer.length > 0) {
          return `data:image/jpeg;base64,${buffer.toString("base64")}`;
        }
      }
      return null;
    } catch (error: any) {
      console.error("Failed to download channel photo:", error);
      return null;
    }
  }

  async downloadSongThumbnail(
    channelUsername: string,
    messageId: number,
    userId?: any
  ): Promise<string | null> {
    try {
      await this.initialize(userId);
      const username = channelUsername.replace("@", "");
      const entity = await this.client!.getEntity(username);
      const messages = await this.client!.getMessages(entity, {
        ids: messageId,
      });
      if (!messages[0] || !messages[0].media) return null;
      const doc = (messages[0].media as any).document;
      if (!doc) return null;
      return await this.getDocumentThumbnail(doc, username, messageId);
    } catch (error: any) {
      console.error("Failed to download song thumbnail:", error);
      return null;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch {}
      this.client = null;
      this.currentProxyConfig = null;
    }
  }
}

export default new TelegramService();