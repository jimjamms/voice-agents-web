import sounddevice as sd

print("All devices (sounddevice's own indexing):\n")
print(sd.query_devices())

print("\nHost APIs and their default input device:")
for i, api in enumerate(sd.query_hostapis()):
    default_idx = api["default_input_device"]
    if default_idx is not None and default_idx >= 0:
        dev_name = sd.query_devices(default_idx)["name"]
        print(f"  [{i}] {api['name']}: default input = [{default_idx}] {dev_name}")
    else:
        print(f"  [{i}] {api['name']}: no default input device")