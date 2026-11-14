import assert from 'node:assert/strict';
import test from 'node:test';
import { joinedPlayer } from './observers.mjs';

// Lines as the two programs write them to the console file (paper-server.md "Log lines", out/A-*-file.stdout).
const vanillaJoin = '[20:34:25] [Server thread/INFO]: Probe joined the game';
const paperJoin = '[20:34:25 INFO]: \x1b[38;2;255;255;85mProbe joined the game\x1b[0m';

test('a vanilla join line is seen', () => {
  assert.equal(joinedPlayer(vanillaJoin), 'Probe');
});

test('a Paper join line is seen', () => {
  assert.equal(joinedPlayer(paperJoin), 'Probe');
});

test('a leave line is not a join', () => {
  assert.equal(joinedPlayer('[20:34:26 INFO]: \x1b[38;2;255;255;85mProbe left the game\x1b[0m'), undefined);
});

test('a chat line cannot fake a join', () => {
  assert.equal(joinedPlayer('[20:34:25] [Server thread/INFO]: <Probe> Other joined the game'), undefined);
  assert.equal(joinedPlayer('[20:34:25 INFO]: [Not Secure] <Probe> Other joined the game'), undefined);
  assert.equal(joinedPlayer('[20:34:25] [Server thread/INFO]: <Probe> hi: Evil joined the game'), undefined);
});
