import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chown, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { URL } from 'node:url';
import test from 'node:test';
import { runActor } from '../eval/actor.ts';
import { CODEX_CLI_VERSION } from '../eval/codex.ts';
import { startEvalServer } from '../eval/server.ts';
import { handleMcp } from '../../src/protocol.ts';
import { MODEL, exec, spawn, message, terminal, stream } from '../support/native-codex.ts';
import { listen, closeServer } from '../support/relay.ts';

// Opt-in only: real pinned native CLI through final actor UID and trusted relay;
// all upstream/MCP application responses remain synthetic, never provider/Google.
test(
  'native Codex isolated integration: resources, inert execution, exact files, forbidden mixed output and 503',
  {
    skip: !process.env.EVAL_NATIVE_CODEX_CLI,
    timeout: 90_000,
  },
  async (t) => {
    assert.equal(process.getuid?.(), 0, 'Run native Codex preflight through the root act harness');
    for (const scenario of ['success', 'mixed', '503'] as const)
      await t.test(scenario, async () => {
        const retained = process.env.EVAL_OUTPUT;
        if (retained) await mkdir(retained, { recursive: true, mode: 0o700 });
        const output = await mkdtemp(join(retained || tmpdir(), `native-codex-${scenario}-`));
        const canary = join(output, 'private-canary.png');
        await writeFile(
          canary,
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=',
            'base64',
          ),
          { mode: 0o600 },
        );
        // This directory permits this UID to write: native refusal must come
        // from its workspace policy, independently of protected evidence modes.
        const outsideRoot = await mkdtemp(join(tmpdir(), 'native-codex-outside-'));
        await chown(outsideRoot, 61337, 61337);
        const outside = join(outsideRoot, 'outside-answer.json');
        const writable = spawnSync(
          process.execPath,
          [
            '-e',
            'const fs=require("node:fs");fs.writeFileSync(process.argv[1],"canary");fs.unlinkSync(process.argv[1]);',
            outside,
          ],
          { uid: 61337, gid: 61337, cwd: tmpdir() },
        );
        assert.equal(writable.status, 0, writable.stderr.toString());
        const modelRequests: any[] = [];
        let executions = 0;
        const capturedOpening = JSON.parse(
          await readFile(
            new URL('../eval/fixtures/native-codex-opening.json', import.meta.url),
            'utf8',
          ),
        );
        const code = `const describe=ALL_TOOLS.find(t=>t.name==='mcp__google__describe'); text(await tools[describe.name]({})); const listed=await tools.list_mcp_resources({server:'google'}); const listing=JSON.stringify(listed); const start=listing.indexOf('skill://'); if(start<0)throw Error('Missing native resource URI'); const end=listing.indexOf('/SKILL.md',start); if(end<0)throw Error('Missing native skill resource'); const uri=listing.slice(start,end+'/SKILL.md'.length); text(await tools.read_mcp_resource({server:'google',uri})); text(await tools.mcp__google__execute({accessToken:'injected-by-eval-caller',code:'return 42;'})); text(await tools.apply_patch(${JSON.stringify('*** Begin Patch\n*** Add File: answer.json\n+{"code":"synthetic"}\n*** End Patch')})); for(const path of ${JSON.stringify([canary])}) { try { await tools.view_image({path}); text({protectedRead:false,path}); } catch(error) { text({protectedRead:true,path,message:String(error)}); } } try { await tools.apply_patch(${JSON.stringify(`*** Begin Patch\n*** Add File: ${outside}\n+outside\n*** End Patch`)}); text({outsideWrite:false}); } catch(error) { text({outsideWrite:true,message:String(error)}); }`;
        // The fixture is a scripted provider response, not a model call. Check
        // its JavaScript syntax before starting the native performer.
        new Function(`return async () => { ${code} };`);

        const proxy = createServer(async (request, response) => {
          let raw = '';
          for await (const chunk of request) raw += chunk;
          const body = JSON.parse(raw);
          modelRequests.push(body);
          if (scenario === '503') {
            response
              .writeHead(503, { 'Content-Type': 'application/json' })
              .end(JSON.stringify({ error: { message: 'Synthetic unavailable' } }));
            return;
          }
          const unqualifiedExec = { ...exec(code), namespace: undefined };
          const outputItems =
            modelRequests.length === 1
              ? scenario === 'mixed'
                ? [exec(code), spawn]
                : capturedOpening
              : modelRequests.length === 2
                ? [unqualifiedExec]
                : [message];
          stream(response, terminal(`native-${scenario}-${modelRequests.length}`, outputItems));
        });
        const proxyUrl = await listen(proxy);
        const relay = await startEvalServer({
          runner: 'codex',
          model: MODEL,
          output,
          accessToken: 'synthetic-private-google-token',
          proxyKey: 'synthetic-private-proxy-key',
          proxyUrl: proxyUrl,
          dispatch: (request) =>
            handleMcp(request, {
              snippets: [],
              describe: async () => ({ services: ['gmail/v1'] }),
              execute: async (args) => {
                assert.equal(args.accessToken, 'synthetic-private-google-token');
                executions++;
                return {
                  value: 42,
                  outcomes: [],
                  outcomesComplete: true,
                  hasUnknownOutcome: false,
                };
              },
              runSnippet: async () => {
                throw new Error('No snippets');
              },
            }),
        });
        try {
          const actor = await runActor({
            runner: 'codex',
            model: MODEL,
            output,
            mcpUrl: relay.url + '/mcp',
            proxyUrl: relay.url + '/llm',
            prompt:
              'Complete only this synthetic task using the connected MCP and owned workspace.',
          });
          const stderr = await readFile(join(output, 'performer.stderr'), 'utf8');
          assert.equal(actor.timedOut, false, stderr);
          assert.equal(actor.isolation.uid, 61337);
          assert.ok(actor.isolation.denied.every((entry) => entry.denied));
          assert.ok(
            actor.isolation.denied.some(
              (entry) =>
                entry.path === resolve('apps/executor/tests/eval/actor.ts') && entry.denied,
            ),
          );
          assert.deepEqual(actor.isolation.groups, [61337]);
          const launch = JSON.parse(await readFile(join(output, 'launch.json'), 'utf8'));
          assert.equal(launch.cliVersion, `codex-cli ${CODEX_CLI_VERSION}`);
          assert.equal(launch.environment.CODEX_EVAL_RELAY_KEY, 'local-eval-relay');
          assert.equal(launch.environment.CPA_CLIENT_API_KEY, undefined);
          assert.equal(launch.environment.OPENAI_API_KEY, undefined);
          await assert.rejects(readFile(outside), /ENOENT/);
          if (scenario === 'success') {
            assert.equal(actor.exitCode, 0, stderr);
            assert.equal(actor.transcript.valid, true, JSON.stringify(actor.transcript));
            assert.equal(executions, 1);
            assert.equal(
              Buffer.from(actor.files['answer.json'], 'base64').toString('utf8'),
              '{"code":"synthetic"}\n',
            );
            assert.ok(relay.audit.some((event) => event.method === 'resources/read'));
            assert.ok(
              relay.audit.some(
                (event) => event.method === 'tools/call' && event.params.name === 'execute',
              ),
            );
            assert.equal(modelRequests.length, 3);
            const outputParts = modelRequests[2].input
              .filter((item: any) => item.type === 'custom_tool_call_output')
              .flatMap((item: any) => item.output)
              .map((part: any) => part.text)
              .filter((text: unknown) => typeof text === 'string');
            const observations = outputParts.flatMap((text: string) => {
              try {
                return [JSON.parse(text)];
              } catch {
                return [];
              }
            });
            const protectedReads = observations.filter(
              (item: any) => item && typeof item === 'object' && 'protectedRead' in item,
            );
            assert.equal(
              protectedReads.length,
              1,
              'Actual native read attempted the protected PNG canary',
            );
            assert.ok(protectedReads.every((item: any) => item.protectedRead === true));
            assert.deepEqual(
              protectedReads.map((item: any) => item.path),
              [canary],
            );
            assert.ok(
              protectedReads.every((item: any) => /denied|Permission|EACCES/i.test(item.message)),
            );
            assert.ok(observations.some((item: any) => item.outsideWrite === true));
            const toolOutputs = outputParts.join('\n');
            assert.match(toolOutputs, /protectedRead/);
            assert.ok(!toolOutputs.includes('"protectedRead":false'));
            assert.match(toolOutputs, /denied|Permission|EACCES/i);
            assert.match(toolOutputs, /outsideWrite/);
            assert.ok(!toolOutputs.includes('"outsideWrite":false'));
            assert.equal(actor.usage.totals.inputTokens, 300);
            assert.equal(actor.usage.totals.cacheReadInputTokens, 60);
          } else {
            assert.notEqual(actor.exitCode, 0);
            assert.equal(actor.transcript.valid, false);
            assert.equal(
              executions,
              0,
              'Mixed stream must dispatch zero allowed execution effects',
            );
            assert.ok(!relay.audit.some((event) => event.method === 'tools/call'));
            assert.deepEqual(actor.files, {});
            assert.equal(modelRequests.length, 1, 'No native retry or fallback');
            assert.equal(relay.llm[0].settlementEligible, false);
            assert.equal(relay.llm[0].heldUsd, relay.llm[0].reservationUsd);
            if (scenario === 'mixed') assert.equal(relay.llm[0].nativeOutputRefused, true);
          }
        } finally {
          await relay.close();
          await closeServer(proxy);
          await rm(outsideRoot, { recursive: true, force: true });
          if (!retained) await rm(output, { recursive: true, force: true });
        }
      });
  },
);
