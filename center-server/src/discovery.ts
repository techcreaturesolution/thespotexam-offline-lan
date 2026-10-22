import dgram from 'dgram';

export const DISCOVERY_PROBE = 'THESPOT_DISCOVER_V1';

/** Answers UDP broadcast probes from candidate clients with the server's LAN address and cert pin. */
export const startDiscovery = (port: number, info: () => Record<string, unknown>) => {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (msg, rinfo) => {
    if (msg.toString('utf8').trim() !== DISCOVERY_PROBE) return;
    sock.send(Buffer.from(JSON.stringify({ service: 'thespot-center', ...info() })), rinfo.port, rinfo.address);
  });
  sock.on('error', (e) => console.error('[discovery]', e.message));
  sock.bind(port);
  return sock;
};
