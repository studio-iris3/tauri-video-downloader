from check import query
import json

def main():
    matches = []
    for org in query("query { account { organizations { id } } }")["account"]["organizations"]:
        for c in query("query { channels(input: {organizationId: " + json.dumps(org["id"]) + "}) { id name service } }")["channels"]:
            if c["name"].strip().lower().lstrip("@") == "studioirissyo" and c["service"].lower() in ("twitter", "x"):
                matches.append(c["id"])
    if len(matches) != 1:
        raise SystemExit("Expected one matching X channel")
    post = "映像・音響の現場で欲しかったアプリを形に。Studio Irisでは、配信やイベントに役立つソフトウェアを紹介しています。\nhttps://studioiris-27abm.stores.jp/"
    q = 'mutation { createPost(input: {text: ' + json.dumps(post, ensure_ascii=False) + ', channelId: ' + json.dumps(matches[0]) + ', schedulingType: automatic, mode: shareNow}) { ... on PostActionSuccess { post { id } } ... on MutationError { message } } }'
    result = query(q)["createPost"]
    if not result.get("post"):
        raise SystemExit("Buffer rejected post")
    print("Buffer accepted post:", result["post"]["id"])

if __name__ == "__main__":
    main()
