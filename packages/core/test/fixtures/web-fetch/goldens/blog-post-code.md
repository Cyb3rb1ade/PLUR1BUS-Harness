# Retrying without thundering herds

Posted by Mirela Banda on 9 May 2026

When a downstream service blips, every client retries at once and the blip becomes an outage. The fix is small: add `jitter` to the backoff.

## The naive loop

```ts
for (let attempt = 0; attempt < 5; attempt++) {
  try {
    return await call();
  } catch (err) {
    await sleep(2 ** attempt * 100);
  }
}
```

Every client sleeps for exactly the same durations, so they stay in lock step.

## With full jitter

```ts
const cap = 2 ** attempt * 100;
await sleep(Math.random() * cap);
```

Check the effect with a load test:

```sh
$ k6 run --vus 200 --duration 30s retry.js
```

Retries now spread over the whole window instead of arriving as a spike.
