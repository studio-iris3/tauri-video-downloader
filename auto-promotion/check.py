import json
import os
import urllib.request

def query(q):
    key = os.environ.get("BUFFER_API_KEY")
    if not key:
        raise SystemExit("BUFFER_API_KEY is missing")
    req = urllib.request.Request("https://api.buffer.com", data=json.dumps({"query": q}).encode(), headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        result = json.load(response)
    if result.get("errors") or not result.get("data"):
        raise SystemExit("Buffer GraphQL query failed")
    return result["data"]

def main():
    matches = []
    for org in query("query { account { organizations { id } } }")["account"]["organizations"]:
        channels = query("query { channels(input: {organizationId: " + json.dumps(org["id"]) + "}) { id name service } }")["channels"]
        for channel in channels:
            if channel["name"].strip().lower().lstrip("@") == "studioirissyo" and channel["service"].lower() in ("twitter", "x"):
                matches.append(channel)
    if len(matches) != 1:
        raise SystemExit("Expected exactly one matching X channel")
    print("Buffer connection OK: @studioirissyo. No posts created.")

if __name__ == "__main__":
    main()
