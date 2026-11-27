import json
import re
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen

SHOP = "https://studioiris-27abm.stores.jp/"
HOST = urlsplit(SHOP).hostname

def safe(url):
    p = urlsplit(url)
    return p.scheme == "https" and p.netloc == HOST

def fetch(url):
    if not safe(url):
        raise ValueError("Unexpected shop URL")
    with urlopen(Request(url, headers={"User-Agent": "StudioIrisCatalog/1.0"}), timeout=20) as r:
        if not safe(r.url):
            raise ValueError("Unexpected redirect")
        data = r.read(2000001)
        if len(data) > 2000000:
            raise ValueError("Page too large")
        return data.decode("utf-8", errors="replace")

class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = set()
        self.meta = {}
        self.scripts = []
        self.active = False
        self.buffer = []
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "a" and a.get("href"):
            u = urljoin(SHOP, a["href"])
            if safe(u) and re.fullmatch(r"/items/[A-Za-z0-9_-]+/?", urlsplit(u).path):
                self.links.add(SHOP.rstrip("/") + urlsplit(u).path.rstrip("/"))
        if tag == "meta" and a.get("content"):
            self.meta[a.get("property", a.get("name", ""))] = a["content"]
        if tag == "script" and a.get("type") == "application/ld+json":
            self.active = True
            self.buffer = []
    def handle_data(self, data):
        if self.active:
            self.buffer.append(data)
    def handle_endtag(self, tag):
        if tag == "script" and self.active:
            self.active = False
            try:
                self.scripts.append(json.loads("".join(self.buffer)))
            except ValueError:
                pass

def products(obj):
    if isinstance(obj, list):
        for v in obj:
            yield from products(v)
    elif isinstance(obj, dict):
        t = obj.get("@type", [])
        if t == "Product" or isinstance(t, list) and "Product" in t:
            yield obj
        for v in obj.values():
            if isinstance(v, (dict, list)):
                yield from products(v)

def discover():
    home = Page()
    home.feed(fetch(SHOP))
    if not home.links:
        raise SystemExit("No public product links discovered")
    if len(home.links) > 50:
        raise SystemExit("Catalog exceeds scan limit")
    result = []
    for url in sorted(home.links):
        page = Page()
        page.feed(fetch(url))
        p = next(products(page.scripts), {})
        name = p.get("name") or page.meta.get("og:title")
        if not isinstance(name, str) or not name.strip():
            raise SystemExit("Missing product name")
        offers = p.get("offers", {})
        if not isinstance(offers, dict):
            offers = {}
        result.append({"name": name, "url": url, "description": p.get("description") or page.meta.get("og:description"), "image": p.get("image") or page.meta.get("og:image"), "price": offers.get("price"), "currency": offers.get("priceCurrency"), "availability": offers.get("availability")})
    return result

if __name__ == "__main__":
    print(json.dumps(discover(), ensure_ascii=False, indent=2))
