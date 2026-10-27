"""A stand-in OBS that speaks the real obs-websocket v5 protocol, for tests."""

from __future__ import annotations

import base64
import hashlib
import json
import threading

from websockets.sync.server import serve


class FakeObsServer:
    def __init__(self, password: str = "secret", scenes=("Minecraft", "Schedule I", "Switching")):
        self.password = password
        self.scenes = list(scenes)
        self.current = self.scenes[0]
        self.recording = False
        self.requests: list[str] = []
        self.salt, self.challenge = "c2FsdA==", "Y2hhbGxlbmdl"
        self._server = serve(self._handle, "127.0.0.1", 0, close_timeout=0.2)
        self.port = self._server.socket.getsockname()[1]
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def close(self):
        self._server.shutdown()

    def _expected_auth(self) -> str:
        secret = base64.b64encode(hashlib.sha256((self.password + self.salt).encode()).digest())
        return base64.b64encode(hashlib.sha256(secret + self.challenge.encode()).digest()).decode()

    def _handle(self, ws):
        hello = {"obsWebSocketVersion": "5.5.0", "rpcVersion": 1}
        if self.password:
            hello["authentication"] = {"challenge": self.challenge, "salt": self.salt}
        ws.send(json.dumps({"op": 0, "d": hello}))
        identify = json.loads(ws.recv())
        if self.password and identify["d"].get("authentication") != self._expected_auth():
            ws.close(4009, "Authentication failed.")
            return
        ws.send(json.dumps({"op": 2, "d": {"negotiatedRpcVersion": 1}}))
        for raw in ws:
            msg = json.loads(raw)
            if msg["op"] != 6:
                continue
            d = msg["d"]
            ok, data = self._request(d["requestType"], d.get("requestData") or {})
            ws.send(json.dumps({"op": 7, "d": {
                "requestType": d["requestType"], "requestId": d["requestId"],
                "requestStatus": {"result": ok, "code": 100 if ok else 600},
                "responseData": data,
            }}))

    def _request(self, kind, data):
        self.requests.append(kind)
        if kind == "GetSceneList":
            return True, {"currentProgramSceneName": self.current,
                          "scenes": [{"sceneName": s, "sceneIndex": i} for i, s in enumerate(self.scenes)]}
        if kind == "SetCurrentProgramScene":
            if data["sceneName"] not in self.scenes:
                return False, {}
            self.current = data["sceneName"]
            return True, {}
        if kind == "GetCurrentProgramScene":
            return True, {"sceneName": self.current, "currentProgramSceneName": self.current}
        if kind == "GetRecordStatus":
            return True, {"outputActive": self.recording, "outputPaused": False}
        if kind == "StartRecord":
            self.recording = True
            return True, {}
        if kind == "StopRecord":
            self.recording = False
            return True, {}
        return False, {}
