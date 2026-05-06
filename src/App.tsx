import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { version } from "../package.json";

type FormatType = "mp4" | "mp3";
type ItemStatus = "待機中" | "情報取得中" | "ダウンロード中" | "完了" | "エラー" | "キャンセル済み";

type VideoInfo = { title: string; thumbnail: string };
type DownloadProgressPayload = { job_id: string; percent: number };

type DownloadItem = {
  id: string;
  url: string;
  title: string;
  thumbnail: string;
  formatType: FormatType;
  mp4Quality: string;
  mp3Quality: string;
  progress: number;
  status: ItemStatus;
  message: string;
};

const mp4Qualities = [
  { label: "最高画質", value: "best" },
  { label: "1080p", value: "1080" },
  { label: "720p", value: "720" },
  { label: "480p", value: "480" },
];
const mp3Qualities = [
  { label: "320kbps", value: "320K" },
  { label: "192kbps", value: "192K" },
  { label: "128kbps", value: "128K" },
];
const cookieBrowsers = [
  { label: "Cookieなし", value: "none" },
  { label: "Chrome", value: "chrome" },
  { label: "Safari", value: "safari" },
  { label: "Firefox", value: "firefox" },
  { label: "Brave", value: "brave" },
  { label: "Edge", value: "edge" },
];

function createId() { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

function App() {
  const [urlText, setUrlText] = useState("");
  const [savePath, setSavePath] = useState("");
  const [items, setItems] = useState<DownloadItem[]>([]);
  const itemsRef = useRef<DownloadItem[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [isDownloading, setIsDownloading] = useState(false);
  const cancelledIdsRef = useRef<Set<string>>(new Set());

  const [bulkFormatType, setBulkFormatType] = useState<FormatType>("mp4");
  const [bulkMp4Quality, setBulkMp4Quality] = useState("1080");
  const [bulkMp3Quality, setBulkMp3Quality] = useState("192K");
  const [cookieBrowser, setCookieBrowser] = useState("none");
  const [concurrentCount, setConcurrentCount] = useState(3);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => { itemsRef.current = items; }, [items]);

  // プログレスバーとログ更新（修正版）
  useEffect(() => {
    let lastUpdate = 0;
    const unlistenProgress = listen<DownloadProgressPayload>("download-progress", (event) => {
      const now = Date.now();
      if (now - lastUpdate < 100) return; // 100msごとに更新
      lastUpdate = now;
      const { job_id, percent } = event.payload;
      const widthPercent = Math.min(100, Math.max(0, percent * 100)); // 0〜1 -> 0〜100
      setItems(prev => prev.map(i => i.id === job_id ? { ...i, progress: widthPercent } : i));
    });
    const unlistenLog = listen<string>("download-log", (event) => {
      setLogs(prev => [...prev.slice(-120), event.payload]);
    });
    return () => { unlistenProgress.then(u => u()); unlistenLog.then(u => u()); };
  }, []);

  async function chooseFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") setSavePath(selected);
  }

  function addUrls() {
    const urls = urlText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length && /^https?:\/\//i.test(l));
    if (!urls.length) { setMessage("有効なURLを入力してください"); return; }
    const newItems: DownloadItem[] = urls.map(url => ({
      id: createId(), url, title:"", thumbnail:"", formatType:bulkFormatType,
      mp4Quality:bulkMp4Quality, mp3Quality:bulkMp3Quality, progress:0, status:"待機中", message:""
    }));
    setItems(prev => [...prev, ...newItems]); setUrlText(""); setMessage(`${newItems.length}件追加`);
  }

  function updateItem(id:string, patch:Partial<DownloadItem>){ setItems(prev=>prev.map(i=>i.id===id ? {...i,...patch}:i)); }
  function clearItems(){ if(isDownloading) return; cancelledIdsRef.current.clear(); setItems([]); setLogs([]); setMessage("リストクリア"); }
  function removeItem(id:string){ if(isDownloading) return; cancelledIdsRef.current.delete(id); setItems(prev=>prev.filter(i=>i.id!==id)); }

  function applyBulkSettings(){
    setItems(prev => prev.map(i=>({
      ...i,
      formatType: bulkFormatType,
      mp4Quality: bulkMp4Quality,
      mp3Quality: bulkMp3Quality
    })));
    setMessage("一括設定適用");
  }

  async function getInfoForItem(item:DownloadItem){
    updateItem(item.id,{status:"情報取得中",message:"取得中..."});
    try{
      const res=await invoke<VideoInfo>("get_video_info",{url:item.url,cookieBrowser});
      updateItem(item.id,{title:res.title,thumbnail:res.thumbnail,status:"待機中",message:"情報取得完了"});
    }catch(e){ updateItem(item.id,{status:"エラー",message:String(e)});}
  }

  async function getInfoAll(){
    if(!items.length){ setMessage("URL追加してください"); return; }
    setMessage("情報取得中...");
    const concurrency = 3;
    let i = 0;
    async function worker(){
      while(i<itemsRef.current.length){
        const idx = i; i++;
        const item = itemsRef.current[idx];
        if(cancelledIdsRef.current.has(item.id)) continue;
        await getInfoForItem(item);
      }
    }
    await Promise.all(Array.from({length:concurrency},()=>worker()));
    setMessage("情報取得完了");
  }

  async function runSingleDownload(id:string){
    if(cancelledIdsRef.current.has(id)) return;
    const item=itemsRef.current.find(i=>i.id===id); if(!item) return; if(item.status==="完了") return;
    updateItem(id,{status:"ダウンロード中",progress:0,message:"ダウンロード中..."});
    try{
      const result=await invoke<string>("download_video",{jobId:item.id,url:item.url,savePath,formatType:item.formatType,mp4Quality:item.mp4Quality,mp3Quality:item.mp3Quality,cookieBrowser});
      if(cancelledIdsRef.current.has(id)) updateItem(id,{status:"キャンセル済み",progress:0,message:"キャンセル"}); else updateItem(id,{status:"完了",progress:100,message:result});
    }catch(e){ if(cancelledIdsRef.current.has(id)) updateItem(id,{status:"キャンセル済み",progress:0,message:"キャンセル"}); else updateItem(id,{status:"エラー",message:String(e)});}
  }

  async function downloadAll(){
    if(!savePath){ setMessage("保存先選択"); return; }
    if(!items.length){ setMessage("URL追加してください"); return; }
    setIsDownloading(true); setLogs([]); setMessage(`同時DL ${concurrentCount}で開始`);
    const queue=itemsRef.current.filter(i=>i.status!=="完了").filter(i=>!cancelledIdsRef.current.has(i.id)).map(i=>i.id);
    let cursor=0;
    async function worker(){ while(cursor<queue.length){ const id=queue[cursor]; cursor++; await runSingleDownload(id); } }
    await Promise.all(Array.from({length:Math.min(concurrentCount,queue.length)},()=>worker()));
    setIsDownloading(false); setMessage("ダウンロード完了");
  }

  return (
    <div style={{padding:24,fontFamily:'-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',background:"linear-gradient(135deg,#0f172a,#020617)",minHeight:"100vh",color:"#e5e7eb"}}>
      
      {/* ヘッダー */}
      <header style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24}}>
        <h1 style={{fontSize:28,fontWeight:700}}>Studio Iris Video Downloader</h1>
        <button onClick={()=>setShowHelp(true)} style={buttonStyle("purple")}>？ヘルプ</button>
      </header>

      {/* 上部パネル */}
      <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:16}}>
        <select value={bulkFormatType} onChange={e=>setBulkFormatType(e.target.value as FormatType)}>
          <option value="mp4">MP4</option>
          <option value="mp3">MP3</option>
        </select>
        {bulkFormatType==="mp4" && <select value={bulkMp4Quality} onChange={e=>setBulkMp4Quality(e.target.value)}>{mp4Qualities.map(q=><option key={q.value} value={q.value}>{q.label}</option>)}</select>}
        {bulkFormatType==="mp3" && <select value={bulkMp3Quality} onChange={e=>setBulkMp3Quality(e.target.value)}>{mp3Qualities.map(q=><option key={q.value} value={q.value}>{q.label}</option>)}</select>}
        <select value={cookieBrowser} onChange={e=>setCookieBrowser(e.target.value)}>{cookieBrowsers.map(c=><option key={c.value} value={c.value}>{c.label}</option>)}</select>
        <input type="number" value={concurrentCount} onChange={e=>setConcurrentCount(Math.max(1,Number(e.target.value)))} style={{width:60}} />
        <button onClick={applyBulkSettings} style={buttonStyle("blue")}>一括適用</button>
        <button onClick={getInfoAll} style={buttonStyle("orange")}>全URL情報取得</button>
      </div>

      {/* URL入力と操作ボタン */}
      <div style={{display:"flex",gap:16,marginBottom:20}}>
        <textarea value={urlText} onChange={e=>setUrlText(e.target.value)} placeholder="URLを1行ずつ" style={{flex:1,height:100,padding:12,borderRadius:14,background:"#1e293b",border:"1px solid #334155",color:"#e5e7eb",outline:"none"}}/>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <button onClick={addUrls} style={buttonStyle("blue")}>追加</button>
          <button onClick={chooseFolder} style={buttonStyle("green")}>保存先</button>
          <button onClick={()=>clearItems()} style={buttonStyle("red")}>クリア</button>
          <button onClick={downloadAll} style={buttonStyle("purple")}>{isDownloading?"実行中...":"ダウンロード"}</button>
        </div>
      </div>

      {/* ジョブリスト */}
      <div style={{display:"grid",gap:12}}>
        {items.map(item=>(
          <div key={item.id} style={{display:"flex",gap:12,padding:12,background:"#1e293b",borderRadius:16,boxShadow:"0 6px 20px rgba(0,0,0,0.3)"}}>
            <div style={{width:140,height:80,background:"#020617",borderRadius:12,overflow:"hidden"}}>
              {item.thumbnail?<img src={item.thumbnail} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:"No Image"}
            </div>
            <div style={{flex:1}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{fontWeight:700,fontSize:16}}>{item.title||"タイトル未取得"}</div>
                <span style={{fontSize:12}}>{item.status}</span>
              </div>
              <div style={{fontSize:12,color:"#94a3b8"}}>{item.url}</div>
              <div style={{display:"flex",gap:6,marginTop:8,flexWrap:"wrap"}}>
                <select value={item.formatType} onChange={e=>updateItem(item.id,{formatType:e.target.value as FormatType})} style={{borderRadius:6,padding:"4px 8px"}}><option value="mp4">MP4</option><option value="mp3">MP3</option></select>
                {item.formatType==="mp4" && <select value={item.mp4Quality} onChange={e=>updateItem(item.id,{mp4Quality:e.target.value})} style={{borderRadius:6,padding:"4px 8px"}}>{mp4Qualities.map(q=><option key={q.value} value={q.value}>{q.label}</option>)}</select>}
                {item.formatType==="mp3" && <select value={item.mp3Quality} onChange={e=>updateItem(item.id,{mp3Quality:e.target.value})} style={{borderRadius:6,padding:"4px 8px"}}>{mp3Qualities.map(q=><option key={q.value} value={q.value}>{q.label}</option>)}</select>}
                <button onClick={()=>getInfoForItem(item)} style={buttonStyle("orange")}>情報取得</button>
                <button onClick={()=>retryItem(item.id)} style={buttonStyle("blue")}>再試行</button>
                <button onClick={()=>cancelItem(item.id)} style={buttonStyle("red")}>停止</button>
                <button onClick={()=>removeItem(item.id)} style={buttonStyle("gray")}>削除</button>
              </div>
              <div style={{height:8,background:"#334155",borderRadius:6,marginTop:8}}>
                <div style={{height:"100%",width:`${item.progress}%`,background:"linear-gradient(90deg,#2563eb,#22c55e)",borderRadius:6}}/>
              </div>
              {item.message && <div style={{fontSize:12,color:"#cbd5e1",marginTop:4}}>{item.message}</div>}
            </div>
          </div>
        ))}
      </div>

      {/* フッター */}
      <footer style={{textAlign:"center",marginTop:32,color:"#64748b",fontSize:12}}>
        &copy; 2026 Studio Iris | v{version}
      </footer>

      {/* ヘルプモーダル */}
      {showHelp && (
        <div style={{position:"fixed",top:0,left:0,width:"100%",height:"100%",background:"rgba(0,0,0,0.6)",display:"flex",justifyContent:"center",alignItems:"center"}}>
          <div style={{background:"#1e293b",padding:24,borderRadius:16,width:440,boxShadow:"0 8px 32px rgba(0,0,0,0.6)"}}>
            <h2 style={{marginTop:0}}>使い方</h2>
            <ul style={{paddingLeft:20}}>
              <li>URLを1行ずつ入力して「追加」</li>
              <li>MP4/MP3、画質・音質は個別・一括設定可能</li>
              <li>「全URL情報取得」ボタンで並列情報取得（高速）</li>
              <li>Cookie対応：年齢制限・ログイン動画用</li>
              <li>同時ダウンロード数を指定可能</li>
              <li>ジョブごとに停止・再試行・削除可能</li>
              <li>プログレスバーで進行状況を確認</li>
            </ul>
            <button onClick={()=>setShowHelp(false)} style={{marginTop:12,padding:"6px 14px",borderRadius:8,background:"linear-gradient(135deg,#7c3aed,#2563eb)",color:"#fff"}}>閉じる</button>
          </div>
        </div>
      )}
    </div>
  );
}

const buttonStyle = (color:"blue"|"green"|"red"|"purple"|"orange"|"gray")=>{
  const map: Record<string,string> = {
    blue:"linear-gradient(135deg,#2563eb,#22c55e)",
    green:"linear-gradient(135deg,#16a34a,#22c55e)",
    red:"linear-gradient(135deg,#dc2626,#f87171)",
    purple:"linear-gradient(135deg,#7c3aed,#2563eb)",
    orange:"linear-gradient(135deg,#f97316,#fbbf24)",
    gray:"linear-gradient(135deg,#64748b,#94a3b8)",
  };
  return {padding:"6px 12px",borderRadius:8,border:"none",background:map[color],color:"#fff",fontWeight:700,cursor:"pointer"};
};

export default App;