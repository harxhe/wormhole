# @wormhole/protocol

Custom binary framing protocol shared between the relay server and the tunnel
client. See [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md) for the wire format and
[`../docs/API.md`](../docs/API.md) for the module API.

## Exports

```ts
import { encodeFrame, FrameDecoder, FrameType, MAX_PAYLOAD } from "@wormhole/protocol";

const frame = encodeFrame(FrameType.DATA, 1, Buffer.from("hello"));
const frames = new FrameDecoder().push(frame);
```

See [`../docs/API.md`](../docs/API.md) for the full API.

## Develop

```sh
npm install         # from the repo root
npm test            # from the repo root, runs vitest
```
