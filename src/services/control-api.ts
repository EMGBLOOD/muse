// Local control API for CruiseBot's Staff Panel.
//
// This is a CruiseBot-specific addition, not part of upstream Muse. It is
// intentionally additive (new file only) so it stays low-conflict across
// upstream merges: it never modifies existing command/service behavior, it
// only calls the same PlayerManager/Player methods the slash commands
// already use.
//
// Reachable only from the Docker host (via a 127.0.0.1-only published port -
// see docker-compose.yml) and gated by a bearer token. Never publish this
// port on anything other than 127.0.0.1.

import http, {IncomingMessage, ServerResponse} from 'http';
import {Client, ChannelType, VoiceChannel} from 'discord.js';
import {inject, injectable} from 'inversify';
import {TYPES} from '../types.js';
import Config from './config.js';
import PlayerManager from '../managers/player.js';
import Player, {STATUS} from './player.js';
import GetSongs from './get-songs.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {prisma} from '../utils/db.js';

interface RouteMatch {
  guildId: string;
}

type Handler = (req: IncomingMessage, res: ServerResponse, params: RouteMatch, body: any) => Promise<void>;

// Maps "METHOD /path" -> the ControlApiServer instance method name that handles it.
// Built as a name table (not direct function refs) because the handlers are
// instance arrow-function class fields, which don't exist on the prototype
// until an instance is constructed.
const ROUTES: Record<string, keyof ControlApiServer> = {
  'GET /state': 'routeState',
  'GET /queue': 'routeQueue',
  'POST /join': 'routeJoin',
  'POST /play': 'routePlay',
  'POST /pause': 'routePause',
  'POST /resume': 'routeResume',
  'POST /skip': 'routeSkip',
  'POST /unskip': 'routeUnskip',
  'POST /replay': 'routeReplay',
  'POST /stop': 'routeStop',
  'POST /disconnect': 'routeDisconnect',
  'POST /shuffle': 'routeShuffle',
  'POST /clear': 'routeClear',
  'POST /seek': 'routeSeek',
  'POST /fseek': 'routeForwardSeek',
  'POST /volume': 'routeVolume',
  'POST /move': 'routeMove',
  'POST /remove': 'routeRemove',
  'POST /loop': 'routeLoop',
  'POST /loop-queue': 'routeLoopQueue',
  'GET /settings': 'routeGetSettings',
  'PATCH /settings': 'routePatchSettings',
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const serializeSong = (player: Player) => {
  const song = player.getCurrent();
  if (!song) {
    return null;
  }

  return {
    title: song.title,
    artist: song.artist,
    url: song.url,
    length: song.length,
    isLive: song.isLive,
    thumbnailUrl: song.thumbnailUrl,
    requestedBy: song.requestedBy,
    playlist: song.playlist,
  };
};

const serializeState = (player: Player) => ({
  status: STATUS[player.status],
  connected: player.voiceConnection !== null,
  voiceChannelId: player.voiceConnection?.joinConfig.channelId ?? null,
  current: serializeSong(player),
  positionSeconds: player.getPosition(),
  volume: player.getVolume(),
  loopCurrentSong: player.loopCurrentSong,
  loopCurrentQueue: player.loopCurrentQueue,
  queueSize: player.queueSize(),
});

@injectable()
export default class ControlApiServer {
  private readonly config: Config;
  private readonly client: Client;
  private readonly playerManager: PlayerManager;
  private readonly getSongs: GetSongs;
  private server: http.Server | undefined;

  constructor(
    @inject(TYPES.Config) config: Config,
    @inject(TYPES.Client) client: Client,
    @inject(TYPES.Managers.Player) playerManager: PlayerManager,
    @inject(TYPES.Services.GetSongs) getSongs: GetSongs,
  ) {
    this.config = config;
    this.client = client;
    this.playerManager = playerManager;
    this.getSongs = getSongs;
  }

  start(): void {
    if (!this.config.CONTROL_API_ENABLED) {
      return;
    }

    if (!this.config.CONTROL_API_TOKEN) {
      console.error('CONTROL_API_ENABLED is true but CONTROL_API_TOKEN is empty - refusing to start control API.');
      return;
    }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch(error => {
        console.error('Unhandled control API error:', error);
        if (!res.headersSent) {
          this.sendJson(res, 500, {error: 'internal error'});
        }
      });
    });

    // Binds on all interfaces *inside* the container - Docker's port publishing
    // forwards to the container's bridge interface, not its loopback, so a
    // 127.0.0.1-only bind here would be unreachable even from the host. The
    // actual trust boundary is the docker-compose port mapping
    // ("127.0.0.1:PORT:PORT"), which restricts this to host-local processes
    // only. The bearer token is the second layer of defense either way.
    this.server.listen(this.config.CONTROL_API_PORT, () => {
      console.log(`Control API listening on :${this.config.CONTROL_API_PORT}`);
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://internal');
    const {pathname} = url;

    if (req.method === 'GET' && pathname === '/health') {
      this.sendJson(res, 200, {ok: true});
      return;
    }

    const authHeader = req.headers.authorization ?? '';
    if (authHeader !== `Bearer ${this.config.CONTROL_API_TOKEN}`) {
      this.sendJson(res, 401, {error: 'unauthorized'});
      return;
    }

    const guildMatch = /^\/guilds\/(?<guildId>\d+)(?<rest>\/.*)$/.exec(pathname);
    if (!guildMatch?.groups) {
      this.sendJson(res, 404, {error: 'not found'});
      return;
    }

    const {guildId} = guildMatch.groups;
    const rest = guildMatch.groups.rest;
    const method = req.method ?? 'GET';
    const routeKey = `${method} ${rest}`;

    const methodName = ROUTES[routeKey];
    if (!methodName) {
      this.sendJson(res, 404, {error: 'not found'});
      return;
    }

    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      this.sendJson(res, 404, {error: 'bot is not in that guild'});
      return;
    }

    let body: any = {};
    if (method === 'POST' || method === 'PATCH') {
      body = await this.readJsonBody(req).catch(() => {
        throw new HttpError(400, 'invalid JSON body');
      });
    }

    try {
      const handler = this[methodName] as unknown as Handler;
      await handler(req, res, {guildId}, body);
    } catch (error) {
      if (error instanceof HttpError) {
        this.sendJson(res, error.status, {error: error.message});
      } else {
        const message = error instanceof Error ? error.message : 'internal error';
        this.sendJson(res, 400, {error: message});
      }
    }
  }

  private readJsonBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', chunk => {
        raw += chunk;
        if (raw.length > 1_000_000) {
          reject(new Error('body too large'));
          req.destroy();
        }
      });
      req.on('end', () => {
        if (!raw) {
          resolve({});
          return;
        }

        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(error);
        }
      });
      req.on('error', reject);
    });
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)});
    res.end(body);
  }

  private async resolveVoiceChannel(guildId: string, voiceChannelId: string): Promise<VoiceChannel> {
    const channel = await this.client.channels.fetch(voiceChannelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildVoice || channel.guildId !== guildId) {
      throw new HttpError(404, 'voice channel not found in this guild');
    }

    return channel;
  }

  // Bound as methods on `this` via ROUTES below (uses arrow functions assigned in the
  // ROUTES map - see bottom of file).
  routeState = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch): Promise<void> => {
    const player = this.playerManager.get(guildId);
    this.sendJson(res, 200, serializeState(player));
  };

  routeQueue = async (req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch): Promise<void> => {
    const player = this.playerManager.get(guildId);
    const url = new URL(req.url ?? '/', 'http://internal');
    const page = Number(url.searchParams.get('page') ?? '1');
    const pageSize = Number(url.searchParams.get('pageSize') ?? '10');
    const queue = player.getQueue();
    const start = (Math.max(page, 1) - 1) * pageSize;
    const slice = queue.slice(start, start + pageSize).map((song, index) => ({
      position: start + index + 1,
      title: song.title,
      artist: song.artist,
      length: song.length,
      isLive: song.isLive,
      requestedBy: song.requestedBy,
    }));

    this.sendJson(res, 200, {
      page,
      pageSize,
      total: queue.length,
      totalLengthSeconds: queue.reduce((sum, song) => sum + song.length, 0),
      songs: slice,
    });
  };

  routeJoin = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch, body: any): Promise<void> => {
    if (!body.voiceChannelId) {
      throw new HttpError(400, 'voiceChannelId is required');
    }

    const channel = await this.resolveVoiceChannel(guildId, body.voiceChannelId);
    const player = this.playerManager.get(guildId);
    await player.connect(channel);
    this.sendJson(res, 200, serializeState(player));
  };

  routePlay = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch, body: any): Promise<void> => {
    const query: string = (body.query ?? '').trim();
    if (!query) {
      throw new HttpError(400, 'query is required');
    }

    if (!body.voiceChannelId) {
      throw new HttpError(400, 'voiceChannelId is required');
    }

    if (!body.requestedByUserId) {
      throw new HttpError(400, 'requestedByUserId is required');
    }

    const channel = await this.resolveVoiceChannel(guildId, body.voiceChannelId);
    const player = this.playerManager.get(guildId);

    const settings = await getGuildSettings(guildId);
    const [newSongs] = await this.getSongs.getSongs(query, settings.playlistLimit, Boolean(body.split));

    if (newSongs.length === 0) {
      throw new HttpError(404, 'no songs found');
    }

    for (const song of newSongs) {
      player.add({
        ...song,
        addedInChannelId: body.textChannelId ?? channel.id,
        requestedBy: body.requestedByUserId,
      }, {immediate: Boolean(body.immediate)});
    }

    if (player.voiceConnection === null) {
      await player.connect(channel);
      await player.play();
    } else if (player.status === STATUS.IDLE) {
      await player.play();
    }

    if (body.skipCurrent) {
      await player.forward(1).catch(() => {
        throw new HttpError(409, 'no song to skip to');
      });
    }

    this.sendJson(res, 200, {addedCount: newSongs.length, firstTitle: newSongs[0].title, state: serializeState(player)});
  };

  routePause = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch): Promise<void> => {
    const player = this.playerManager.get(guildId);
    if (player.status !== STATUS.PLAYING) {
      throw new HttpError(409, 'not currently playing');
    }

    player.pause();
    this.sendJson(res, 200, serializeState(player));
  };

  routeResume = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch, body: any): Promise<void> => {
    const player = this.playerManager.get(guildId);
    if (player.status === STATUS.PLAYING) {
      throw new HttpError(409, 'already playing');
    }

    if (!player.getCurrent()) {
      throw new HttpError(409, 'nothing to play');
    }

    if (!body.voiceChannelId) {
      throw new HttpError(400, 'voiceChannelId is required');
    }

    const channel = await this.resolveVoiceChannel(guildId, body.voiceChannelId);
    await player.connect(channel);
    await player.play();
    this.sendJson(res, 200, serializeState(player));
  };

  routeSkip = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch, body: any): Promise<void> => {
    const player = this.playerManager.get(guildId);
    const amount = Number(body.amount ?? 1);
    if (amount < 1) {
      throw new HttpError(400, 'amount must be at least 1');
    }

    await player.forward(amount).catch(() => {
      throw new HttpError(409, 'no song to skip to');
    });
    this.sendJson(res, 200, serializeState(player));
  };

  routeUnskip = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch): Promise<void> => {
    const player = this.playerManager.get(guildId);
    await player.back().catch(() => {
      throw new HttpError(409, 'no song to go back to');
    });
    this.sendJson(res, 200, serializeState(player));
  };

  routeReplay = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch): Promise<void> => {
    const player = this.playerManager.get(guildId);
    const current = player.getCurrent();
    if (!current) {
      throw new HttpError(409, 'nothing is playing');
    }

    if (current.isLive) {
      throw new HttpError(409, "can't replay a livestream");
    }

    await player.seek(0);
    this.sendJson(res, 200, serializeState(player));
  };

  routeStop = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch): Promise<void> => {
    const player = this.playerManager.get(guildId);
    if (!player.voiceConnection) {
      throw new HttpError(409, 'not connected');
    }

    player.stop();
    this.sendJson(res, 200, serializeState(player));
  };

  routeDisconnect = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch): Promise<void> => {
    const player = this.playerManager.get(guildId);
    if (!player.voiceConnection) {
      throw new HttpError(409, 'not connected');
    }

    player.disconnect();
    this.sendJson(res, 200, serializeState(player));
  };

  routeShuffle = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch): Promise<void> => {
    const player = this.playerManager.get(guildId);
    if (player.queueSize() < 1) {
      throw new HttpError(409, 'not enough songs to shuffle');
    }

    player.shuffle();
    this.sendJson(res, 200, serializeState(player));
  };

  routeClear = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch): Promise<void> => {
    const player = this.playerManager.get(guildId);
    player.clear();
    this.sendJson(res, 200, serializeState(player));
  };

  routeSeek = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch, body: any): Promise<void> => {
    const player = this.playerManager.get(guildId);
    const current = player.getCurrent();
    if (!current) {
      throw new HttpError(409, 'nothing is playing');
    }

    if (current.isLive) {
      throw new HttpError(409, "can't seek in a livestream");
    }

    const seconds = Number(body.seconds);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > current.length) {
      throw new HttpError(400, 'invalid seconds');
    }

    await player.seek(seconds);
    this.sendJson(res, 200, serializeState(player));
  };

  routeForwardSeek = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch, body: any): Promise<void> => {
    const player = this.playerManager.get(guildId);
    const current = player.getCurrent();
    if (!current) {
      throw new HttpError(409, 'nothing is playing');
    }

    if (current.isLive) {
      throw new HttpError(409, "can't seek in a livestream");
    }

    const seconds = Number(body.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new HttpError(400, 'invalid seconds');
    }

    if (seconds + player.getPosition() > current.length) {
      throw new HttpError(400, "can't seek past the end of the song");
    }

    await player.forwardSeek(seconds);
    this.sendJson(res, 200, serializeState(player));
  };

  routeVolume = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch, body: any): Promise<void> => {
    const player = this.playerManager.get(guildId);
    if (!player.getCurrent()) {
      throw new HttpError(409, 'nothing is playing');
    }

    const level = Number(body.level);
    if (!Number.isFinite(level) || level < 0 || level > 100) {
      throw new HttpError(400, 'level must be 0-100');
    }

    player.setVolume(level);
    this.sendJson(res, 200, serializeState(player));
  };

  routeMove = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch, body: any): Promise<void> => {
    const player = this.playerManager.get(guildId);
    const from = Number(body.from);
    const to = Number(body.to);
    if (!Number.isInteger(from) || from < 1 || !Number.isInteger(to) || to < 1) {
      throw new HttpError(400, 'from/to must be positions >= 1');
    }

    const {title} = player.move(from, to);
    this.sendJson(res, 200, {movedTitle: title, state: serializeState(player)});
  };

  routeRemove = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch, body: any): Promise<void> => {
    const player = this.playerManager.get(guildId);
    const position = Number(body.position ?? 1);
    const range = Number(body.range ?? 1);
    if (!Number.isInteger(position) || position < 1 || !Number.isInteger(range) || range < 1) {
      throw new HttpError(400, 'position/range must be >= 1');
    }

    player.removeFromQueue(position, range);
    this.sendJson(res, 200, serializeState(player));
  };

  routeLoop = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch): Promise<void> => {
    const player = this.playerManager.get(guildId);
    if (player.status === STATUS.IDLE) {
      throw new HttpError(409, 'no song to loop');
    }

    if (player.loopCurrentQueue) {
      player.loopCurrentQueue = false;
    }

    player.loopCurrentSong = !player.loopCurrentSong;
    this.sendJson(res, 200, serializeState(player));
  };

  routeLoopQueue = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch): Promise<void> => {
    const player = this.playerManager.get(guildId);
    if (player.status === STATUS.IDLE) {
      throw new HttpError(409, 'no songs to loop');
    }

    if (player.queueSize() < 2) {
      throw new HttpError(409, 'not enough songs to loop a queue');
    }

    if (player.loopCurrentSong) {
      player.loopCurrentSong = false;
    }

    player.loopCurrentQueue = !player.loopCurrentQueue;
    this.sendJson(res, 200, serializeState(player));
  };

  routeGetSettings = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch): Promise<void> => {
    const settings = await getGuildSettings(guildId);
    this.sendJson(res, 200, settings);
  };

  routePatchSettings = async (_req: IncomingMessage, res: ServerResponse, {guildId}: RouteMatch, body: any): Promise<void> => {
    await getGuildSettings(guildId); // Ensures a row exists
    const allowedKeys = new Set([
      'playlistLimit',
      'secondsToWaitAfterQueueEmpties',
      'leaveIfNoListeners',
      'queueAddResponseEphemeral',
      'autoAnnounceNextSong',
      'defaultVolume',
      'defaultQueuePageSize',
      'turnDownVolumeWhenPeopleSpeak',
      'turnDownVolumeWhenPeopleSpeakTarget',
    ]);
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (allowedKeys.has(key)) {
        data[key] = value;
      }
    }

    const updated = await prisma.setting.update({where: {guildId}, data});
    this.sendJson(res, 200, updated);
  };
}
