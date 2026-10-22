import fs from 'fs';
import os from 'os';
import path from 'path';

export interface Config {
  dataDir: string;
  cloudUrl: string;
  port: number;
  discoveryPort: number;
  lanIp: string;
  tls: boolean;
  heartbeatSeconds: number;
  autoSubmitGraceSeconds: number;
  clientTimeoutSeconds: number;
  lateSyncWindowSeconds: number;
  retentionDays: number;
  appVersion: string;
}

const firstLanIp = (): string => {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) return ni.address;
  }
  return '127.0.0.1';
};

const defaultDataDir = () =>
  process.platform === 'win32'
    ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'TheSpotExam', 'CenterServer')
    : path.join(os.homedir(), '.thespot-center');

export const loadConfig = (overrides: Partial<Config> = {}): Config => {
  const dataDir = overrides.dataDir || process.env.CENTER_DATA_DIR || defaultDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  let file: Partial<Config> = {};
  const cfgPath = path.join(dataDir, 'config.json');
  if (fs.existsSync(cfgPath)) file = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const num = (v: string | undefined, d: number) => (v ? parseInt(v, 10) : d);
  return {
    dataDir,
    cloudUrl: (process.env.CLOUD_URL || file.cloudUrl || 'https://api.thespotexam.com/api/v1').replace(/\/$/, ''),
    port: num(process.env.CENTER_PORT, file.port ?? 8443),
    discoveryPort: num(process.env.DISCOVERY_PORT, file.discoveryPort ?? 41234),
    lanIp: process.env.LAN_IP || file.lanIp || firstLanIp(),
    tls: (process.env.CENTER_TLS ?? String(file.tls ?? true)) !== 'false',
    heartbeatSeconds: num(process.env.HEARTBEAT_SECONDS, file.heartbeatSeconds ?? 60),
    autoSubmitGraceSeconds: num(process.env.AUTO_SUBMIT_GRACE_SECONDS, file.autoSubmitGraceSeconds ?? 15),
    clientTimeoutSeconds: num(process.env.CLIENT_TIMEOUT_SECONDS, file.clientTimeoutSeconds ?? 30),
    lateSyncWindowSeconds: num(process.env.LATE_SYNC_WINDOW_SECONDS, file.lateSyncWindowSeconds ?? 600),
    retentionDays: num(process.env.RETENTION_DAYS, file.retentionDays ?? 30),
    appVersion: process.env.npm_package_version || '0.1.0',
    ...overrides,
  };
};
