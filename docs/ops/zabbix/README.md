# Zabbix template

The `plur1bus-template.yaml` file is a Zabbix 7.0 template for the harness
metrics endpoint. Enable metrics in `config.json` and restart the core:

```json
{ "metrics": { "enabled": true, "port": 9464 } }
```

The endpoint binds to loopback only, so the Zabbix server, proxy, or agent that
polls it must run on the harness host.

1. In Zabbix, open **Data collection → Templates → Import** and select
   `plur1bus-template.yaml`.
2. Link **PLUR1BUS Harness by HTTP** to the harness host.
3. Set the template's `{$PLUR1BUS.METRICS.TOKEN}` macro to the contents of
   `<home>/state/metrics.token`. Store it as a secret; do not put the token in
   this file or commit it.
4. If `metrics.port` is not `9464`, update `{$PLUR1BUS.METRICS.PORT}` to match.

The template fetches `/metrics` once per minute and uses dependent items to
collect the individual metrics. See [the metrics documentation](../metrics.md)
for endpoint access rules, metric definitions, and trigger details.
