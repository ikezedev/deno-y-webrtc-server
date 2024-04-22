const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;
const pingTimeout = 30000;

const topics = new Map<string, Set<WebSocket>>();
const clients = new Map<string, WebSocket>();

type Ping = { type: "ping" };
type Pong = { type: "pong" };
type Subscribe = { type: "subscribe"; topics: string[] };
type Unsubscribe = { type: "unsubscribe"; topics: string[] };
type Publish = { type: "publish"; topic: string };
interface WebSocketEx extends WebSocket {
  id: string;
  ip: string;
}

type YWebRtcData = Ping | Pong | Subscribe | Unsubscribe | Publish;

const setIfUndefined = <K, V>(map: Map<K, V>, key: K, createT: () => V) => {
  let set = map.get(key);
  if (set === undefined) {
    map.set(key, set = createT());
  }
  return set;
};

const send = (conn: WebSocket, message: YWebRtcData) => {
  if (
    conn.readyState !== wsReadyStateConnecting &&
    conn.readyState !== wsReadyStateOpen
  ) {
    conn.close();
  }
  try {
    conn.send(JSON.stringify(message));
  } catch (_) {
    conn.close();
  }
};

function guardYWebRtcData(
  data: YWebRtcData | string,
): asserts data is YWebRtcData {
  if (typeof data === "string" || !("type" in data)) {
    throw new Error("Not valid data shape", { cause: data });
  }
}

Deno.serve({ port: 4444 }, (req, conn) => {
  const ip = conn.remoteAddr.hostname;
  if (req.headers.get("upgrade") != "websocket") {
    return new Response(null, { status: 501 });
  }
  const { socket, response } = Deno.upgradeWebSocket(req) as {
    socket: WebSocketEx;
    response: Response;
  };

  const id = crypto.randomUUID().toString();
  socket.id = id;
  socket.ip = ip;
  clients.set(id, socket);

  const subscribedTopics = new Set<string>();
  let closed = false;
  let pongReceived = true;

  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      socket.close();
      clearInterval(pingInterval);
    } else {
      pongReceived = false;
      try {
        send(socket, { type: "ping" });
      } catch (_) {
        socket.close();
      }
    }
  }, pingTimeout);

  socket.addEventListener("pong", () => {
    pongReceived = true;
  });

  socket.addEventListener("open", () => {
    console.log(`${socket.id} connected on ip ${socket.ip}`);
    console.debug("Connected clients", clients.size);
  });

  socket.addEventListener("close", () => {
    subscribedTopics.forEach((topicName) => {
      const subs = topics.get(topicName) || new Set();
      subs.delete(socket);
      if (subs.size === 0) {
        topics.delete(topicName);
      }
    });
    subscribedTopics.clear();
    closed = true;
    console.log("a client disconnected!", socket.id, clients.delete(socket.id));
    console.debug("Connected clients", clients.size);
  });

  socket.addEventListener(
    "message",
    function (this: WebSocket, event: MessageEvent<YWebRtcData | string>) {
      // Implement y-webtrc protocol
      if (closed) return;
      let message = event.data;
      if (typeof message === "string") {
        message = JSON.parse(message);
      }

      guardYWebRtcData(message);

      if (message.type === "subscribe") {
        (message.topics || []).forEach((topicName) => {
          const topic = setIfUndefined(topics, topicName, () => new Set());
          topic.add(this);
          subscribedTopics.add(topicName);
        });
      }

      if (message.type === "unsubscribe") {
        (message.topics || []).forEach((topicName) => {
          const subs = topics.get(topicName);
          if (subs) {
            subs.delete(this);
          }
        });
      }

      if (message.type === "publish") {
        const receivers = topics.get(message.topic);
        if (receivers) {
          receivers.forEach((receiver) => send(receiver, message as Publish));
        }
      }

      if (message.type === "ping") {
        send(this, { type: "pong" });
      }
    },
  );

  return response;
});
