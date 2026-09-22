### Task 8 (PR-02c): `runtimeIfUsable(api)` → `host.runtime` inside `index.js`

29 sites. Three of them pass the runtime *on* as a value and need `?? undefined` to stay byte-equivalent.

**Files:**
- Modify: `index.js`
- Modify: `tests/index-host-logger.test.js` — add one assertion

**Interfaces:**
- Consumes: `host` from Task 7.
- Produces: nothing new. `runtimeIfUsable` stays exported from `lib/runtime-shutdown.js` (other modules and tests import it) and stays imported by `lib/host-services.js`; only `index.js` stops calling it.

**The two shapes:**

1. **Probes (26 sites)** — `runtimeIfUsable(api)?.…` or `runtimeIfUsable(api).…`. Replace the call with `host.runtime`, keeping the rest of the expression exactly:

```js
// before, index.js:3311
    const cfg = commandConfig || runtimeIfUsable(api)?.config?.current?.();
// after
    const cfg = commandConfig || host.runtime?.config?.current?.();
```

```js
// before, index.js:12322
              getSessionEntry: ({ agentId, sessionKey, readConsistency }) => runtimeIfUsable(api).agent.session.getSessionEntry({ agentId, sessionKey, readConsistency }),
// after
              getSessionEntry: ({ agentId, sessionKey, readConsistency }) => host.runtime.agent.session.getSessionEntry({ agentId, sessionKey, readConsistency }),
```

A non-optional `.agent` read (`:7204`, `:9288`, `:9314`, `:9331`, `:12322`) throws today when the runtime is absent and must keep throwing — `host.runtime` returning `null` gives the same `TypeError`.

2. **Pass-throughs (3 sites)** — `index.js:5326`, `:7099`, `:7134`, each `runtime: runtimeIfUsable(api),`. `runtimeIfUsable` yields `undefined` when unusable; `host.runtime` yields `null`. Downstream code may distinguish them, so preserve the value exactly:

```js
        runtime: host.runtime ?? undefined,
```

- [ ] **Step 1: List every site so nothing is missed**

```bash
cd "$PLUR1BUS" && grep -n "runtimeIfUsable(api)" index.js
cd "$PLUR1BUS" && grep -c "runtimeIfUsable(api)" index.js
```

Expected: 29 occurrences on 28 lines (line `4240` carries two).

- [ ] **Step 2: Add the guard assertion**

Append to the `describe("PR-02b host logger", …)` block in `tests/index-host-logger.test.js`:

```js
  it("index.js reaches the host runtime through HostServices", () => {
    const source = readFileSync(join(root, "index.js"), "utf8");
    assert.doesNotMatch(source, /runtimeIfUsable\s*\(\s*api\s*\)/, "use host.runtime");
    assert.match(source, /host\.runtime/);
  });
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/index-host-logger.test.js 2>&1 | tail -10
```

Expected: `fail 1` on the new assertion.

- [ ] **Step 4: Rewrite the three pass-throughs by hand first**

At `index.js:5326`, `:7099` and `:7134`, change `runtime: runtimeIfUsable(api),` to `runtime: host.runtime ?? undefined,`. Confirm exactly three:

```bash
cd "$PLUR1BUS" && grep -n "runtime: host.runtime ?? undefined," index.js
```

- [ ] **Step 5: Rewrite the remaining 26 probes**

```bash
cd "$PLUR1BUS"
perl -pi -e 's/\bruntimeIfUsable\(api\)/host.runtime/g' index.js
grep -n "runtimeIfUsable(api)" index.js   # must print nothing
```

Then drop `runtimeIfUsable` from the `./lib/runtime-shutdown.js` import list at `index.js:159` **only if** nothing else in `index.js` uses it:

```bash
cd "$PLUR1BUS" && grep -n "runtimeIfUsable" index.js
```

If the only hit is the import, remove the name from that import list.

- [ ] **Step 6: Syntax check and guard test**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check index.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/index-host-logger.test.js 2>&1 | tail -8
```

Expected: `--check` silent; `tests 4`, `pass 4`, `fail 0`.

- [ ] **Step 7: Run the runtime-sensitive tests explicitly**

These are the ones that exercise restricted registration and the throwing proxy:

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 \
  tests/openclaw-restricted-registration.test.js \
  tests/b12p-runtime-reachability.test.js \
  tests/runtime-config-contract.test.js \
  tests/openclaw-default-llm-runtime.test.js \
  tests/openclaw-default-llm-callers.test.js 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 8: Lint, suite, golden**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: lint 0; golden `pass 7 / fail 0`; suite at the accepted baseline.

- [ ] **Step 9: Commit**

```bash
cd "$PLUR1BUS"
git add index.js tests/index-host-logger.test.js
git commit -m "refactor(host): read the host runtime through HostServices in index.js

PR-02c. host.runtime is an accessor, so the proxy probe still runs on every
read. The three sites that pass the runtime on keep '?? undefined' so a host
without one still receives undefined, not null."
```

---

