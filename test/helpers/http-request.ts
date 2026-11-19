import type { INestApplication } from '@nestjs/common';
import { type IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex, Readable } from 'node:stream';

/** Real Nest/Express routing, parsers and response serialization, through in-memory HTTP streams.
 * Opens no listener or network connection. These tests do not replace PostgreSQL integration.
 */
export function httpRequest(application: INestApplication, path: string, body: unknown, headers: readonly (readonly [string, string])[] = [], rawBody?: string, method = 'POST'): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = new Duplex({ read() {}, write(chunk: Buffer, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    const request = new Readable({ read() {}, autoDestroy: false }) as IncomingMessage;
    Object.assign(request, { socket, connection: socket, complete: false });
    const data = rawBody ?? JSON.stringify(body) ?? '';
    request.method = method; request.url = path; request.httpVersion = '1.1'; request.httpVersionMajor = 1; request.httpVersionMinor = 1;
    const values = [['content-type', 'application/json'], ['content-length', String(Buffer.byteLength(data))], ...headers] as const;
    Object.defineProperty(request, 'headers', { value: {}, writable: true });
    request.rawHeaders = values.flatMap(([key, value]) => [key, value]);
    for (const [key, value] of values) {
      const name = key.toLowerCase(); request.headers[name] = request.headers[name] ? `${request.headers[name]}, ${value}` : value;
    }
    const response = new ServerResponse(request); response.assignSocket(socket as Socket);
    request.on('error', reject); response.on('error', reject);
    response.on('finish', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').split('\r\n\r\n').slice(1).join('\r\n\r\n');
        resolve({ status: response.statusCode, body: text ? JSON.parse(text) as unknown : undefined });
      } catch (error) { reject(error); }
      finally { response.detachSocket(socket as Socket); socket.destroy(); }
    });
    application.getHttpServer().emit('request', request, response);
    request.push(Buffer.from(data)); request.push(null);
  });
}
