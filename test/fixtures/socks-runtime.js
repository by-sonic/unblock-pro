'use strict';

// A tiny loopback-only SOCKS fixture. CI separately exercises the real tpws.
const net = require('node:net');
const mode = process.argv[2];
const port = Number(process.argv.find((arg) => arg.startsWith('--port=')).slice(7));
if (mode === 'never-listens') {
  setInterval(() => {}, 1000);
} else {
  net.createServer((socket) => {
    socket.on('error', () => {});
    if (mode === 'crash') return process.kill(process.pid, 'SIGKILL');
    if (mode === 'hang') return;
    let pending = Buffer.alloc(0);
    let greeted = false;
    const onData = (data) => {
      pending = Buffer.concat([pending, data]);
      if (!greeted) {
        if (pending.length < 3) return;
        pending = pending.subarray(3);
        greeted = true;
        // Fragment the greeting to cover TCP framing.
        socket.write(Buffer.from([5]));
        setImmediate(() => socket.write(Buffer.from([0])));
      }
      if (pending.length < 5) return;
      // Require a domain CONNECT so the preflight cannot silently stop testing
      // the resolver path that crashed on macOS. Reject all non-local targets.
      if (pending[0] !== 5 || pending[1] !== 1 || pending[2] !== 0 || pending[3] !== 3) {
        socket.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
        return;
      }
      const hostnameLength = pending[4];
      const requestLength = 7 + hostnameLength;
      if (pending.length < requestLength) return;
      if (pending.subarray(5, 5 + hostnameLength).toString('ascii') !== 'localhost') {
        socket.destroy();
        return;
      }
      if (mode === 'crash-on-domain') return process.kill(process.pid, 'SIGKILL');
      if (mode === 'hang-on-domain') return;
      const replies = {
        deny: [5, 2, 0, 1, 0, 0, 0, 0, 0, 0],
        'invalid-reply': [5, 1, 0, 1, 0, 0, 0, 0, 0, 0],
        'invalid-version': [4, 2, 0, 1, 0, 0, 0, 0, 0, 0],
        'invalid-reserved': [5, 2, 1, 1, 0, 0, 0, 0, 0, 0],
        'invalid-address': [5, 2, 0, 0, 0, 0, 0, 0, 0, 0],
        'truncated-policy': [5, 2, 0, 1, 0]
      };
      if (replies[mode]) {
        socket.end(Buffer.from(replies[mode]));
        return;
      }
      const targetPort = pending.readUInt16BE(5 + hostnameLength);
      socket.removeListener('data', onData);
      const target = net.connect(targetPort, '127.0.0.1', () => {
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        socket.pipe(target).pipe(socket);
      });
      target.on('error', () => socket.destroy());
      socket.once('close', () => target.destroy());
    };
    socket.on('data', onData);
  }).listen(port, '127.0.0.1');
}
