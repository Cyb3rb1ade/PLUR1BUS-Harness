# queue.push

Adds a job to a queue and returns its identifier.

## Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `queue` | string | yes | Name of the target queue. |
| `payload` | object | yes | Arbitrary JSON delivered to the worker. |
| `priority` | integer | no | 0 to 9, default 5. |
| `delay_ms` | integer | no | Wait before the job becomes runnable. |

## Errors

**queue_full**

The queue holds its maximum number of waiting jobs.

**payload_too_large**

The payload exceeds 256 KiB after serialisation.

**unknown_queue**

No queue with that name exists in the workspace.

## Example response

```json
{
  "id": "job_8f2c1a",
  "queue": "emails",
  "state": "waiting"
}
```
