import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { version } from "../package.json"; // package.jsonのversionを読み込み

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
  const [concurrentCount, setConcurrentCount] = useState(2);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => { itemsRef.current = items; }, [items]);

  useEffect(() => {
    const unlistenProgressPromise = listen<DownloadProgressPayload>("download-progress", (event) => {
      const { job_id, percent } = event.payload;
      setItems((prev) => prev.map((item) => item.id === job_id ? { ...item, progress: percent } : item));
    });
    const unlistenLogPromise = listen<string>("download-log", (event) => {
      setLogs((prev) => [...prev.slice(-120), event.payload]);
    });
    return () => {
      unlistenProgressPromise.then((unlisten) => unlisten());
      unlistenLogPromise.then((unlisten) => unlisten());
    };
  }, []);

  async function chooseFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") setSavePath(selected);
  }

  function addUrls() {
    const urls = urlText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && /^https?:\/\//i.test(line));
    if (urls.length === 0) { setMessage("有効なURLを入力してください。"); return; }
    const newItems: DownloadItem[] = urls.map((url) => ({
      id: createId(), url, title: "", thumbnail: "", formatType: bulkFormatType,
      mp4Quality: bulkMp4Quality, mp3Quality: bulkMp3Quality, progress: 0, status: "待機中", message: ""
    }));
    setItems((prev) => [...prev, ...newItems]);
    setUrlText("");
    setMessage(`${newItems.length}件追加しました。`);
  }

  function updateItem(id: string, patch: Partial<DownloadItem>) {
    setItems((prev) => prev.map((item) => item.id === id ? { ...item, ...patch } : item));
  }
  function clearItems() { if (isDownloading) return; cancelledIdsRef.current.clear(); setItems([]); setLogs([]); setMessage("リストをクリアしました。"); }
  function removeItem(id: string) { if (isDownloading) return; cancelledIdsRef.current.delete(id); setItems((prev) => prev.filter((item) => item.id !== id)); }
  function applyBulkSettings() { setItems((prev) => prev.map((item) => ({ ...item, formatType: bulkFormatType, mp4Quality: bulkMp4Quality, mp3Quality: bulkMp3Quality }))); setMessage("一括設定を適用しました。"); }
  function moveItem(id: string, direction: "up"|"down"|"top") {
    if (isDownloading) return; setItems((prev)=>{ const index = prev.findIndex(item=>item.id===id); if(index<0)return prev; const next=[...prev]; const [t]=next.splice(index,1); if(direction==="top") next.unshift(t); if(direction==="up") next.splice(Math.max(0,index-1),0,t); if(direction==="down") next.splice(Math.min(next.length,index+1),0,t); return next; });
  }

  async function cancelItem(id:string) { cancelledIdsRef.current.add(id); updateItem(id,{status:"キャンセル済み",progress:0,message:"キャンセルしました。"}); try{ await invoke<string>("cancel_download",{jobId:id}); }catch(e){setLogs(prev=>[...prev.slice(-120),`キャンセルエラー: ${String(e)}`]);}}
  function retryItem(id:string){ cancelledIdsRef.current.delete(id); updateItem(id,{status:"待機中",progress:0,message:"再試行待機中です。"});}

  async function getInfoForItem(item: DownloadItem) {
    updateItem(item.id,{status:"情報取得中",message:"動画情報を取得中..."});
    try{
      const result = await invoke<VideoInfo>("get_video_info",{url:item.url,cookieBrowser});
      updateItem(item.id,{title:result.title,thumbnail:result.thumbnail,status:"待機中",message:"情報取得済み"});
    }catch(e){ updateItem(item.id,{status:"エラー",message:String(e)});}
  }

  async function getInfoAll() {
    if(items.length===0){ setMessage("URLを追加してください"); return;}
    setMessage("動画情報を取得中...");
    for(const item of itemsRef.current){ if(cancelledIdsRef.current.has(item.id)) continue; await getInfoForItem(item); }
    setMessage("動画情報の取得が完了しました。");
  }

  async function runSingleDownload(id:string){
    if(cancelledIdsRef.current.has(id)) return;
    const item = itemsRef.current.find(i=>i.id===id); if(!item) return;
    if(item.status==="完了") return;
    updateItem(id,{status:"ダウンロード中",progress:0,message:"ダウンロード中..."});
    try{
      const result=await invoke<string>("download_video",{jobId:item.id,url:item.url,savePath,formatType:item.formatType,mp4Quality:item.mp4Quality,mp3Quality:item.mp3Quality,cookieBrowser});
      if(cancelledIdsRef.current.has(id)) updateItem(id,{status:"キャンセル済み",progress:0,message:"キャンセルしました。"});
      else updateItem(id,{status:"完了",progress:100,message:result});
    }catch(e){
      if(cancelledIdsRef.current.has(id)) updateItem(id,{status:"キャンセル済み",progress:0,message:"キャンセルしました。"});
      else updateItem(id,{status:"エラー",message:String(e)});
    }
  }

  async function downloadAll(){
    if(!savePath){ setMessage("保存先を選択してください"); return;}
    if(items.length===0){ setMessage("URLを追加してください"); return;}
    setIsDownloading(true); setLogs([]); setMessage(`同時ダウンロード数 ${concurrentCount} で開始`);
    const queue = itemsRef.current.filter(i=>i.status!=="完了").filter(i=>!cancelledIdsRef.current.has(i.id)).map(i=>i.id);
    let cursor=0;
    async function worker(){ while(cursor<queue.length){ const id=queue[cursor]; cursor+=1; await runSingleDownload(id); } }
    const workers = Array.from({length:Math.min(concurrentCount,queue.length)},()=>worker());
    await Promise.all(workers);
    setIsDownloading(false); setMessage("ダウンロードが完了しました。");
  }

  const waitingCount = items.filter(i=>i.status==="待機中").length;
  const downloadingCount = items.filter(i=>i.status==="ダウンロード中").length;
  const doneCount = items.filter(i=>i.status==="完了").length;
  const errorCount = items.filter(i=>i.status==="エラー").length;
  const cancelledCount = items.filter(i=>i.status==="キャンセル済み").length;

  return (
    <div style={{padding:20, fontFamily:'sans-serif',background:"#0f172a",color:"#e5e7eb"}}>
      {/* ヘッダー */}
      <header style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
        <h1>動画ダウンローダー</h1>
        <button onClick={()=>setShowHelp(true)} style={{padding:"6px 12px",borderRadius:8}}>？ヘルプ</button>
      </header>

      {/* URL入力と設定 */}
      <div style={{display:"flex",gap:12,marginBottom:16}}>
        <textarea value={urlText} onChange={e=>setUrlText(e.target.value)} placeholder="URLを1行ずつ" style={{flex:1,height:80,padding:10,borderRadius:12,background:"#1e293b",border:"1px solid #334155",color:"#e5e7eb"}}/>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          <button onClick={addUrls} style={buttonStyle}>追加</button>
          <button onClick={chooseFolder} style={buttonStyle}>保存先</button>
          <button onClick={clearItems} style={buttonStyle}>クリア</button>
          <button onClick={downloadAll} style={buttonStyle}>{isDownloading?"実行中...":"ダウンロード"}</button>
        </div>
      </div>

      {/* URLリスト */}
      <div style={{display:"grid",gap:10}}>
        {items.map((item,index)=>(
          <div key={item.id} style={{display:"flex",gap:10,padding:10,background:"#1e293b",borderRadius:12}}>
            <div style={{width:120,height:68,background:"#020617"}}>
              {item.thumbnail?<img src={item.thumbnail} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:"No Image"}
            </div>
            <div style={{flex:1}}>
              <div style={{display:"flex",justifyContent:"space-between"}}><div>{item.title||"タイトル未取得"}</div><span>{item.status}</span></div>
              <div style={{fontSize:12,color:"#94a3b8"}}>{item.url}</div>
              <div style={{display:"flex",gap:6,marginTop:6}}>
                <select value={item.formatType} onChange={e=>updateItem(item.id,{formatType:e.target.value as FormatType})} style={{borderRadius:6,padding:"2px 6px"}}><option value="mp4">MP4</option><option value="mp3">MP3</option></select>
                <button onClick={()=>retryItem(item.id)} style={buttonStyle}>再試行</button>
                <button onClick={()=>cancelItem(item.id)} style={buttonStyle}>停止</button>
                <button onClick={()=>removeItem(item.id)} style={buttonStyle}>削除</button>
              </div>
              <div style={{height:6,background:"#334155",borderRadius:6,marginTop:6}}>
                <div style={{height:"100%",width:`${item.progress}%`,background:"#2563eb",borderRadius:6}}/>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* フッター */}
      <footer style={{textAlign:"center",marginTop:20,color:"#64748b",fontSize:12}}>
        &copy; 2026 Studio Iris | v{version}
      </footer>

      {/* ヘルプモーダル */}
      {showHelp && (
        <div style={{position:"fixed",top:0,left:0,width:"100%",height:"100%",background:"rgba(0,0,0,0.6)",display:"flex",justifyContent:"center",alignItems:"center"}}>
          <div style={{background:"#1e293b",padding:20,borderRadius:12,width:400}}>
            <h2>使い方</h2>
            <ul style={{paddingLeft:20}}>
              <li>URLを1行ずつ入力して「追加」</li>
              <li>MP4/MP3、画質、音質を選択</li>
              <li>Cookieは年齢制限・ログインが必要な動画用</li>
              <li>同時ダウンロード数を設定可能</li>
              <li>ジョブをキャンセル・再試行可能</li>
            </ul>
            <button onClick={()=>setShowHelp(false)} style={{marginTop:10,padding:"6px 12px",borderRadius:6}}>閉じる</button>
          </div>
        </div>
      )}
    </div>
  );
}

const buttonStyle: CSSProperties = {border:"none",borderRadius:6,padding:"6px 12px",background:"#2563eb",color:"#e5e7eb",cursor:"pointer"};
export default App;