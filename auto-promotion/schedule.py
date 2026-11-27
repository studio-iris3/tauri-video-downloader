from datetime import datetime, timedelta, timezone
from check import query
import json
import os

JST = timezone(timedelta(hours=9))
SHOP = "https://studioiris-27abm.stores.jp/"
COPY = [
("映像・音響の現場で欲しかったアプリを形に。Studio Irisのショップをご覧ください。", "Explore Studio Iris software, inspired by real-world AV workflows."),
("Stream Deckによる動画や音声のポン出しを検討中の方へ。Studio Irisのアプリをご紹介します。", "Looking for a way to cue video and audio with Stream Deck? Explore Studio Iris."),
("配信やイベントの準備をもっと便利に。Studio Irisのソフトウェアをご覧ください。", "Preparing a live event or stream? Discover software from Studio Iris.")
]

def main():
    matches = []
    for org in query("query { account { organizations { id } } }")["account"]["organizations"]:
        for c in query("query { channels(input: {organizationId: " + json.dumps(org["id"]) + "}) { id name service } }")["channels"]:
            if c["name"].strip().lower().lstrip("@") == "studioirissyo" and c["service"].lower() in ("twitter", "x"):
                matches.append((org["id"], c["id"]))
    if len(matches) != 1:
        raise SystemExit("Expected one matching X channel")
    org, channel = matches[0]
    now = datetime.now(JST)
    day = now.date() + timedelta(days=1)
    cursor = None
    seen = set()
    occupied = set()
    for _ in range(20):
        q = 'query { posts(first: 100' + (', after: ' + json.dumps(cursor) if cursor else '') + ', input: {organizationId: ' + json.dumps(org) + ', filter: {channelIds: [' + json.dumps(channel) + ']}}) { edges { node { text dueAt } } pageInfo { hasNextPage endCursor } } }'
        p = query(q)["posts"]
        for edge in p["edges"]:
            n = edge["node"]
            seen.add(n["text"])
            if n.get("dueAt"):
                occupied.add(datetime.fromisoformat(n["dueAt"].replace("Z","+00:00")))
        if not p["pageInfo"]["hasNextPage"]:
            break
        cursor = p["pageInfo"]["endCursor"]
    else:
        raise SystemExit("History scan limit; no posts created")
    for i, hour in enumerate((12, 23)):
        due = datetime(day.year, day.month, day.day, hour, tzinfo=JST).astimezone(timezone.utc)
        if due in occupied:
            continue
        candidates = [pair[i] + "\n" + SHOP for pair in COPY]
        post = next((x for x in candidates if x not in seen), None)
        if not post:
            print("No unused approved template; skipping")
            continue
        if os.environ.get("PROMOTION_ENABLED") != "true":
            print("Preview:", due.isoformat(), post)
            continue
        q = 'mutation { createPost(input: {text: ' + json.dumps(post, ensure_ascii=False) + ', channelId: ' + json.dumps(channel) + ', schedulingType: automatic, mode: customScheduled, dueAt: ' + json.dumps(due.isoformat().replace("+00:00","Z")) + '}) { ... on PostActionSuccess { post { id } } ... on MutationError { message } } }'
        result = query(q)["createPost"]
        if not result.get("post"):
            raise SystemExit("Buffer rejected reservation; stopping")
        seen.add(post)
        print("Reserved", due.isoformat())

if __name__ == "__main__":
    main()
