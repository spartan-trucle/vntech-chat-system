import { createChatServer } from './server.js';

const port = Number(process.env['PORT'] ?? 8080);
const server = await createChatServer({ port, seed: true });
console.log(`chat prototype listening on ${server.url} (http ${server.httpUrl}/health)`);
process.on('SIGINT', () => void server.close().then(() => process.exit(0)));
