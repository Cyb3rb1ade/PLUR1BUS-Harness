# Usage and limits

The Usage & Quota page (`#/usage`) shows what your agents have used and where the limits are. Usage is always counted. Limits decide what happens when you reach a number: a **soft limit** warns, a **hard limit** stops further model calls (or, for a media limit, further images and videos). The German version of this page is [../de/budgets.md](../de/budgets.md).

## Reading the page

- Each meter shows one limit as "used of limit (percent)", for example *Daily tokens*, *Daily images* or *Monthly video seconds*.
- The **Usage** tab shows tokens, images generated and video seconds generated for today and this month, per agent and model.
- The state is one of: **Within limit**, **Warning: soft limit reached**, **Exceeded: hard limit reached**.
- Without a limit nothing is stopped. The page still shows what has been used so far.

## Setting a limit

1. Choose **Set limit**.
2. Pick the scope: **Global** (all agents together) or one **Agent**.
3. Pick the **metric**:
   - **Tokens**: input and output tokens (output includes reported reasoning tokens).
   - **Images**: generated images. A request for several images is refused whole when they would not all fit.
   - **Video seconds**: seconds of generated video, rounded up to whole seconds.
4. Enter a **soft limit**, a **hard limit**, or both, as a whole number. The soft limit must not be higher than the hard limit. Plur1bus never computes in money; there are no cost limits and no prices shown.
5. Confirm the limit.

Use **Edit limit** to change a limit and **Remove limit** to delete it. Removing asks for confirmation first.

Limits per project or per user are not available yet.

## What happens at the limits

- **Soft limit:** the state changes to a warning. Agents keep working.
- **Hard limit:** further model calls are stopped until the period resets or the limit is raised. A media limit stops only images or videos: the request is refused before it is sent to the provider. If a provider delivers fewer images or a shorter video than requested, only what was delivered counts.
- An image limit does not stop chats or videos, and a token limit is not used up by images.

On the command line: `plur1bus budget set --global --period day --metric images --hard 20` (or `--metric video-seconds`).

## Next

- Model providers and profiles: [providers.md](providers.md)
- Long conversations and summaries, which also use model calls: [long-conversations.md](long-conversations.md)
