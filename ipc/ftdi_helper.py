# FTDI bit-bang helper for the UART Bridge utility.
# Long-lived process: reads one JSON command per line on stdin, writes one JSON
# reply per line on stdout. Keeps FTDI devices open between commands so pins hold
# their state. Mirrors the user's transmit_test.py (ftd2xx async bit-bang).
import sys, json

try:
    import ftd2xx
    _imp_err = None
except Exception as e:  # ftd2xx not installed
    ftd2xx = None
    _imp_err = str(e)

devs = {}  # index -> device handle


def reply(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def handle(msg):
    mid = msg.get("id")
    cmd = msg.get("cmd")
    if ftd2xx is None:
        return {"id": mid, "ok": False, "error": "ftd2xx not installed (pip install ftd2xx): " + str(_imp_err)}
    try:
        if cmd == "list":
            serials = ftd2xx.listDevices() or []
            out = []
            for i, s in enumerate(serials):
                out.append({"index": i, "serial": (s.decode(errors="ignore") if isinstance(s, bytes) else str(s))})
            return {"id": mid, "ok": True, "ports": out}
        if cmd == "open":
            idx = int(msg["index"])
            if idx not in devs:
                devs[idx] = ftd2xx.open(idx)
            return {"id": mid, "ok": True, "index": idx}
        if cmd == "bitmode":
            devs[int(msg["index"])].setBitMode(int(msg["mask"]), int(msg["mode"]))
            return {"id": mid, "ok": True}
        if cmd == "baud":
            devs[int(msg["index"])].setBaudRate(int(msg["baud"]))
            return {"id": mid, "ok": True}
        if cmd == "write":
            devs[int(msg["index"])].write(bytes(msg["bytes"]))
            return {"id": mid, "ok": True}
        if cmd == "close":
            d = devs.pop(int(msg["index"]), None)
            if d is not None:
                try:
                    d.setBitMode(0x00, 0x00)
                except Exception:
                    pass
                d.close()
            return {"id": mid, "ok": True}
        return {"id": mid, "ok": False, "error": "unknown cmd: " + str(cmd)}
    except Exception as e:
        return {"id": mid, "ok": False, "error": str(e)}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            reply({"ok": False, "error": "bad json"})
            continue
        reply(handle(msg))


if __name__ == "__main__":
    main()
