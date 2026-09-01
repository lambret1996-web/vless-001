import { connect } from 'cloudflare:sockets';

let 调试日志打印 = false;
let TCP并发拨号数 = 2, 反代并发拨号数 = 1;
const 上行合包目标字节 = 20 * 1024, 上行队列最大字节 = 16 * 1024 * 1024, 上行队列最大条目 = 4096;
const 下行Grain包字节 = 32 * 1024, 下行Grain尾部阈值 = 512;

const SHA256_K = new Uint32Array([
	0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
	0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
	0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
	0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
	0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
	0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
	0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
	0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);
function sha224(s) {
	const bytes = typeof s === 'string' ? new TextEncoder().encode(s) : new Uint8Array(s);
	const H = new Uint32Array([0xc1059ed8,0x367cd507,0x3070dd17,0xf70e5939,0xffc00b31,0x68581511,0x64f98fa7,0xbefa4fa4]);
	const bitLen = bytes.length * 8;
	const paddedLen = ((bytes.length + 8) >> 6 << 6) + 64;
	const padded = new Uint8Array(paddedLen);
	padded.set(bytes); padded[bytes.length] = 0x80;
	const dv = new DataView(padded.buffer);
	dv.setBigUint64(paddedLen - 8, BigInt(bitLen), false);
	const w = new Uint32Array(64);
	for (let offset = 0; offset < paddedLen; offset += 64) {
		for (let i = 0; i < 16; i++) w[i] = dv.getUint32(offset + i * 4, false);
		for (let i = 16; i < 64; i++) {
			const s0 = (w[i-15]>>>7|w[i-15]<<25)^(w[i-15]>>>18|w[i-15]<<14)^(w[i-15]>>>3);
			const s1 = (w[i-2]>>>17|w[i-2]<<15)^(w[i-2]>>>19|w[i-2]<<13)^(w[i-2]>>>10);
			w[i] = (w[i-16]+s0+w[i-7]+s1)>>>0;
		}
		let [a,b,c,d,e,f,g,h] = H;
		for (let i = 0; i < 64; i++) {
			const S1=(e>>>6|e<<26)^(e>>>11|e<<21)^(e>>>25|e<<7), ch=(e&f)^(~e&g);
			const temp1=(h+S1+ch+SHA256_K[i]+w[i])>>>0;
			const S0=(a>>>2|a<<30)^(a>>>13|a<<19)^(a>>>22|a<<10), maj=(a&b)^(a&c)^(b&c);
			const temp2=(S0+maj)>>>0;
			h=g;g=f;f=e;e=(d+temp1)>>>0;d=c;c=b;b=a;a=(temp1+temp2)>>>0;
		}
		H[0]=(H[0]+a)>>>0;H[1]=(H[1]+b)>>>0;H[2]=(H[2]+c)>>>0;H[3]=(H[3]+d)>>>0;
		H[4]=(H[4]+e)>>>0;H[5]=(H[5]+f)>>>0;H[6]=(H[6]+g)>>>0;H[7]=(H[7]+h)>>>0;
	}
	let hex = '';
	for (let i = 0; i < 7; i++) hex += H[i].toString(16).padStart(8,'0');
	return hex;
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const upgradeHeader = (request.headers.get('Upgrade')||'').toLowerCase();
		const contentType = (request.headers.get('content-type')||'').toLowerCase();
		const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
		const envUUID = env.UUID || env.uuid;
		const userID = (envUUID && uuidRegex.test(envUUID)) ? envUUID.toLowerCase() : (env.ADMIN||env.PASSWORD||env.UUID||'default-uuid-please-set');
		调试日志打印 = ['1','true'].includes(env.DEBUG) || 调试日志打印;
		反代并发拨号数 = Math.max(1, Number(env.PROXY_CONCURRENT_DIAL)||反代并发拨号数);
		TCP并发拨号数 = Math.max(1, Number(env.TCP_CONCURRENT_DIAL)||TCP并发拨号数);
		let 默认反代IP = '', 默认反代兜底 = true;
		if (env.PROXYIP) {
			const proxyIPs = 整理成数组(env.PROXYIP);
			默认反代IP = proxyIPs[Math.floor(Math.random()*proxyIPs.length)];
			默认反代兜底 = false;
		}
		// v2ray 配置生成：访问 域名/UUID
		if (request.method === 'GET' && url.pathname === '/' + userID) {
			return 生成v2ray配置(url.host, userID);
		}
		if (userID && upgradeHeader === 'websocket') {
			const 反代上下文 = 反代参数获取(url, userID, 默认反代IP, 默认反代兜底);
			return await 处理WS请求(request, userID, url, 反代上下文);
		}
		if (userID && request.method === 'POST') {
			const 反代上下文 = 反代参数获取(url, userID, 默认反代IP, 默认反代兜底);
			const {头:本机Padding头,键:本机Padding键} = 获取叉HTTPPadding标识(userID);
			const 命中叉HTTP = !!request.headers.get(本机Padding头) || !!url.searchParams.get(本机Padding键);
			if (!命中叉HTTP && contentType.startsWith('application/grpc')) return await 处理gRPC请求(request, userID, 反代上下文);
			return await 处理叉HTTP请求(request, userID, 反代上下文);
		}
		return new Response('Not Found', { status: 404 });
	}
};

function 生成v2ray配置(host, uuid) {
	const config = {
		"log": { "loglevel": "warning" },
		"inbounds": [{
			"port": 10808, "listen": "127.0.0.1", "protocol": "socks",
			"settings": { "udp": true },
			"sniffing": { "enabled": true, "destOverride": ["http", "tls"] }
		}],
		"outbounds": [{
			"protocol": "vless",
			"settings": { "vnext": [{ "address": host, "port": 443, "users": [{ "id": uuid, "encryption": "none", "level": 0 }] }] },
			"streamSettings": {
				"network": "ws", "security": "tls",
				"tlsSettings": { "serverName": host, "allowInsecure": false },
				"wsSettings": { "path": "/", "headers": { "Host": host } }
			},
			"tag": "proxy"
		}, { "protocol": "freedom", "tag": "direct" }],
		"routing": {
			"domainStrategy": "IPIfNonMatch",
			"rules": [
				{ "type": "field", "ip": ["geoip:private"], "outboundTag": "direct" },
				{ "type": "field", "domain": ["geosite:cn"], "outboundTag": "direct" },
				{ "type": "field", "ip": ["geoip:cn"], "outboundTag": "direct" }
			]
		}
	};
	return new Response(JSON.stringify(config, null, 2), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

function 反代参数获取(url, uuid, 默认反代IP='', 默认反代兜底=true) {
	const 结果 = {反代IP:默认反代IP,反代兜底:默认反代兜底,代理类型:null,代理参数:{},代理全局:false,木马反代地址:null};
	for (const 类型 of ['socks5','http','https']) {
		const v = url.searchParams.get(类型);
		if (v) { 结果.代理类型=类型; try{结果.代理参数=获取SOCKS5账号(v,获取代理默认端口(类型))}catch(e){} break; }
	}
	if (url.searchParams.get('proxyip')==='global') 结果.代理全局=true;
	const 木马反代 = url.searchParams.get('trojan');
	if (木马反代) try{结果.木马反代地址=解析木马反代地址(木马反代)}catch(e){}
	const m = url.pathname.match(/proxyip=([^\/&?#]+)/i);
	if (m) { 结果.反代IP=decodeURIComponent(m[1]); 结果.反代兜底=false; }
	return 结果;
}

async function 处理WS请求(request, yourUUID, url, 反代上下文={}) {
	const [clientSock, serverSock] = new WebSocketPair();
	serverSock.accept();
	const remoteConnWrapper = {socket:null,connectingPromise:null,retryConnect:null,downlinkDrain:Promise.resolve(),generation:0};
	const 失效远端连接 = () => 失效TCP连接世代(remoteConnWrapper);
	let isDnsQuery=false;
	const 木马UDP上下文 = {缓存:new Uint8Array(0),反代地址:反代上下文.木马反代地址};
	let 判断协议类型=null, 判断是否是木马=null, WS本地测速模式=false;
	const 上行写入队列 = 创建上行写入队列({
		获取写入器:()=>remoteConnWrapper.socket?remoteConnWrapper.socket.writable.getWriter():null,
		获取连接任务:()=>remoteConnWrapper.connectingPromise, 释放写入器:()=>{},
		重试连接:async()=>{if(typeof remoteConnWrapper.retryConnect==='function')await remoteConnWrapper.retryConnect()},
		关闭连接:失效远端连接, 名称:'WS上行'
	});
	const 写入远端 = async(payload,allowRetry=true)=>上行写入队列.写入并等待(payload,allowRetry);
	const 启用WS本地测速模式 = async(ws,respHeader)=>{WS本地测速模式=true;await WebSocket发送并等待(ws,构造WS本地204响应(respHeader))};
	const 处理WS本地测速数据 = async(chunk)=>{if(serverSock.readyState===WebSocket.OPEN)await WebSocket发送并等待(serverSock,chunk)};
	const 处理WS入站数据 = async(chunk)=>{
		if (isDnsQuery) { if(判断是否是木马)return await 转发木马UDP数据(chunk,serverSock,木马UDP上下文,request); return await forwardataudp(chunk,serverSock,null,request); }
		if (WS本地测速模式) return await 处理WS本地测速数据(chunk);
		if (await 写入远端(chunk)) return;
		if (判断协议类型===null) {
			const bytes=数据转Uint8Array(chunk);
			判断协议类型 = bytes.byteLength>=58&&bytes[56]===0x0d&&bytes[57]===0x0a?'木马':'魏烈思';
			判断是否是木马 = 判断协议类型==='木马';
		}
		if (判断协议类型==='木马') {
			const r=解析木马请求(chunk,yourUUID);
			if(r?.hasError)throw new Error(r.message);
			if(isSpeedTestSite(r.hostname)&&反代上下文.代理类型===null){await 启用WS本地测速模式(serverSock,null,r.rawClientData);return}
			if(r.isUDP){isDnsQuery=true;木马UDP上下文.目标主机=r.hostname;木马UDP上下文.目标端口=r.port;if(有效数据长度(r.rawClientData)>0)return 转发木马UDP数据(r.rawClientData,serverSock,木马UDP上下文,request);return}
			await forwardataTCP(r.hostname,r.port,r.rawClientData,serverSock,null,remoteConnWrapper,yourUUID,request,反代上下文,true,数据转Uint8Array(chunk));
		} else {
			const bytes=数据转Uint8Array(chunk);
			const r=解析魏烈思请求(bytes,yourUUID);
			if(r?.hasError)throw new Error(r.message);
			const respHeader=new Uint8Array([r.version,0]);
			if(isSpeedTestSite(r.hostname)&&反代上下文.代理类型===null){await 启用WS本地测速模式(serverSock,respHeader,r.rawClientData);return}
			if(r.isUDP){if(r.port===53)isDnsQuery=true;else throw new Error('UDP not supported')}
			if(isDnsQuery)return forwardataudp(r.rawClientData,serverSock,respHeader,request);
			await forwardataTCP(r.hostname,r.port,r.rawClientData,serverSock,respHeader,remoteConnWrapper,yourUUID,request,反代上下文);
		}
	};
	let WS传输链=Promise.resolve(), WS传输失败=false;
	const 处理错误=(err)=>{if(WS传输失败)return;WS传输失败=true;上行写入队列.清空();失效远端连接();closeSocketQuietly(serverSock)};
	serverSock.addEventListener('message',e=>{WS传输链=WS传输链.then(()=>处理WS入站数据(e.data)).catch(处理错误)});
	serverSock.addEventListener('close',()=>{closeSocketQuietly(serverSock);失效远端连接()});
	serverSock.addEventListener('error',处理错误);
	return new Response(null,{status:101,webSocket:clientSock});
}

async function 处理gRPC请求(request, yourUUID, 反代上下文={}) {
	if(!request.body)return new Response('Bad Request',{status:400});
	const reader=request.body.getReader();
	const remoteConnWrapper={socket:null,connectingPromise:null,retryConnect:null,downlinkDrain:Promise.resolve(),generation:0};
	const 木马UDP上下文={缓存:new Uint8Array(0),反代地址:反代上下文.木马反代地址};
	const grpcHeaders=new Headers({'Content-Type':'application/grpc','grpc-status':'0','X-Accel-Buffering':'no','Cache-Control':'no-store'});
	return new Response(new ReadableStream({
		async start(controller){
			let 已关闭=false,发送队列=[],队列字节数=0;
			const grpcBridge={
				readyState:WebSocket.OPEN,
				send(data){if(已关闭)return;const chunk=数据转Uint8Array(data);const lenBytes=[];let remaining=chunk.byteLength>>>0;while(remaining>127){lenBytes.push((remaining&0x7f)|0x80);remaining>>>=7}lenBytes.push(remaining);const protobufLen=1+lenBytes.length+chunk.byteLength;const frame=new Uint8Array(5+protobufLen);frame[0]=0;frame[1]=(protobufLen>>>24)&0xff;frame[2]=(protobufLen>>>16)&0xff;frame[3]=(protobufLen>>>8)&0xff;frame[4]=protobufLen&0xff;frame[5]=0x0a;frame.set(lenBytes,6);frame.set(chunk,6+lenBytes.length);发送队列.push(frame);队列字节数+=frame.byteLength;if(队列字节数>=下行Grain包字节)刷新队列()},
				close(){if(this.readyState===WebSocket.CLOSED)return;刷新队列(true);已关闭=true;this.readyState=WebSocket.CLOSED;try{controller.close()}catch(e){}}
			};
			const 刷新队列=(force=false)=>{if((!force&&已关闭)||队列字节数===0)return;const out=new Uint8Array(队列字节数);let offset=0;for(const item of 发送队列){out.set(item,offset);offset+=item.byteLength}发送队列=[];队列字节数=0;try{controller.enqueue(out)}catch(e){已关闭=true;grpcBridge.readyState=WebSocket.CLOSED}};
			const 关闭连接=()=>{if(已关闭)return;已关闭=true;失效TCP连接世代(remoteConnWrapper);刷新队列(true);grpcBridge.readyState=WebSocket.CLOSED;try{reader.releaseLock()}catch(e){}try{controller.close()}catch(e){}};
			let pending=new Uint8Array(0),首包已处理=false,isDnsQuery=false;
			try{
				while(true){
					const {done,value}=await reader.read();
					if(done)break;
					if(!value||value.byteLength===0)continue;
					const 当前块=数据转Uint8Array(value);
					const merged=new Uint8Array(pending.length+当前块.length);merged.set(pending);merged.set(当前块,pending.length);pending=merged;
					while(pending.byteLength>=5){
						const frameLen=(pending[1]<<24)|(pending[2]<<16)|(pending[3]<<8)|pending[4];
						if(pending.byteLength<5+frameLen)break;
						const protobufData=pending.slice(5,5+frameLen);pending=pending.slice(5+frameLen);
						if(protobufData[0]!==0x0a)continue;
						let idx=1,dataLen=0,shift=0;
						while(idx<protobufData.length){const b=protobufData[idx++];dataLen|=(b&0x7f)<<shift;if(!(b&0x80))break;shift+=7}
						const payload=protobufData.slice(idx,idx+dataLen);
						if(!首包已处理){
							首包已处理=true;
							const bytes=数据转Uint8Array(payload);
							const isTrojan=bytes.byteLength>=58&&bytes[56]===0x0d&&bytes[57]===0x0a;
							if(isTrojan){const r=解析木马请求(payload,yourUUID);if(r?.hasError)throw new Error(r.message);if(r.isUDP){isDnsQuery=true;木马UDP上下文.目标主机=r.hostname;木马UDP上下文.目标端口=r.port}else await forwardataTCP(r.hostname,r.port,r.rawClientData,grpcBridge,null,remoteConnWrapper,yourUUID,request,反代上下文,true,bytes)}
							else{const r=解析魏烈思请求(payload,yourUUID);if(r?.hasError)throw new Error(r.message);const respHeader=new Uint8Array([r.version,0]);if(r.isUDP){if(r.port===53)isDnsQuery=true;else throw new Error('UDP not supported')}if(isDnsQuery)await forwardataudp(r.rawClientData,grpcBridge,respHeader,request);else await forwardataTCP(r.hostname,r.port,r.rawClientData,grpcBridge,respHeader,remoteConnWrapper,yourUUID,request,反代上下文)}
						}else{
							if(isDnsQuery){if(木马UDP上下文.目标主机)await 转发木马UDP数据(payload,grpcBridge,木马UDP上下文,request);else await forwardataudp(payload,grpcBridge,null,request)}
							else if(remoteConnWrapper.socket){const w=remoteConnWrapper.socket.writable.getWriter();await w.write(数据转Uint8Array(payload));w.releaseLock()}
						}
					}
				}
			}catch(err){}finally{关闭连接()}
		},
		cancel(){try{reader.releaseLock()}catch(e){}}
	}),{status:200,headers:grpcHeaders});
}

const HPACKHuffman码长=[13,23,28,28,28,28,28,28,28,24,30,28,28,30,28,28,28,28,28,28,28,28,30,28,28,28,28,28,28,28,28,28,6,10,10,12,13,6,8,11,10,10,8,11,8,6,6,6,5,5,5,6,6,6,6,6,6,6,7,8,15,6,12,10,13,6,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,8,7,8,13,19,13,14,6,15,5,6,5,6,5,6,6,6,5,7,7,6,6,6,5,6,7,6,5,5,6,7,7,7,7,7,15,11,14,13,28];
function 获取叉HTTPPadding标识(yourUUID){return{头:yourUUID.slice(1,7),键:'_'+yourUUID.slice(25,31)}}
function 计算HPACKHuffman字节长度(字符串){const 字节=new TextEncoder().encode(字符串);let 总位数=0;for(let i=0;i<字节.length;i++)总位数+=HPACKHuffman码长[字节[i]];return Math.ceil(总位数/8)}
function 校验叉HTTPPadding(request,本机Padding头,本机Padding键){const 头值=request.headers.get(本机Padding头);let padding值='';if(头值){try{const u=new URL(头值,'https://x.invalid');padding值=u.searchParams.get(本机Padding键)||头值}catch(e){padding值=头值}}else padding值=new URL(request.url).searchParams.get(本机Padding键)||'';if(!padding值)return true;const huffman长度=计算HPACKHuffman字节长度(padding值);return huffman长度>=98&&huffman长度<=1002}
const 叉HTTPBase62字符集='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function 生成叉HTTPPadding串(长度){let 结果='';for(let i=0;i<长度;i++)结果+=叉HTTPBase62字符集[Math.floor(Math.random()*叉HTTPBase62字符集.length)];return 结果}

async function 处理叉HTTP请求(request, yourUUID, 反代上下文={}) {
	if(!request.body)return new Response('Bad Request',{status:400});
	const {头:本机Padding头,键:本机Padding键}=获取叉HTTPPadding标识(yourUUID);
	if(!校验叉HTTPPadding(request,本机Padding头,本机Padding键))return new Response('Bad Request',{status:400});
	const reader=request.body.getReader();
	const 首包=await 读取叉HTTP首包(reader,yourUUID);
	if(!首包){try{reader.releaseLock()}catch(e){}return new Response('Invalid request',{status:400})}
	if(isSpeedTestSite(首包.hostname)&&反代上下文.代理类型===null){try{reader.releaseLock()}catch(e){}return new Response(构造本地204响应(首包.respHeader),{status:200,headers:{'Content-Type':'application/octet-stream','X-Accel-Buffering':'no'}})}
	if(首包.isUDP&&首包.协议!=='trojan'&&首包.port!==53){try{reader.releaseLock()}catch(e){}return new Response('UDP is not supported',{status:400})}
	const responseHeaders=new Headers({'Content-Type':'application/octet-stream','X-Accel-Buffering':'no','Cache-Control':'no-store'});
	try{const 响应URL=new URL('https://x.invalid/');响应URL.searchParams.set(本机Padding键,生成叉HTTPPadding串(100+Math.floor(Math.random()*901)));responseHeaders.set(本机Padding头,响应URL.toString())}catch(e){}
	if(首包.isUDP)return 处理叉HTTPUDP请求(首包,reader,request,反代上下文,responseHeaders);
	try{reader.releaseLock()}catch(e){}
	const remoteConnWrapper={socket:null,connectingPromise:null,retryConnect:null,downlinkDrain:Promise.resolve(),generation:0};
	const abortController=new AbortController();
	let 已清理=false;
	const 清理=()=>{if(已清理)return;已清理=true;try{abortController.abort()}catch(e){}失效TCP连接世代(remoteConnWrapper)};
	const 占位WS={readyState:WebSocket.OPEN};
	let socket;
	try{socket=await forwardataTCP(首包.hostname,首包.port,首包.rawData,占位WS,首包.respHeader,remoteConnWrapper,yourUUID,request,反代上下文,首包.协议==='trojan',首包.原始数据,true)}
	catch(err){清理(err);return new Response('bad gateway',{status:502})}
	if(!socket){清理();return new Response('bad gateway',{status:502})}
	const 上行Promise=(async()=>{const 上行合包器=创建上行Grain合包流();const 搬运Promise=上行合包器.readable.pipeTo(socket.writable,{signal:abortController.signal});void 搬运Promise.catch(清理);const 上行reader=request.body.getReader();try{while(true){const {done,value}=await 上行reader.read();if(done)break;if(value?.byteLength)await 上行合包器.写入(value)}}finally{try{上行reader.releaseLock()}catch(e){}}try{await 上行合包器.结束()}catch(e){}await 搬运Promise})();
	const 响应流=new TransformStream();
	const 下行Promise=(async()=>{const writer=响应流.writable.getWriter();try{if(有效数据长度(首包.respHeader)>0)await writer.write(首包.respHeader)}finally{try{writer.releaseLock()}catch(e){}}await socket.readable.pipeTo(响应流.writable,{signal:abortController.signal})})();
	void 上行Promise.catch(清理);
	void 下行Promise.then(()=>清理(),清理);
	return new Response(响应流.readable,{status:200,headers:responseHeaders});
}

function 处理叉HTTPUDP请求(首包,reader,request,反代上下文,responseHeaders){
	const 木马UDP上下文={缓存:new Uint8Array(0),反代地址:反代上下文.木马反代地址};
	return new Response(new ReadableStream({
		async start(controller){
			let 已关闭=false,udpRespHeader=首包.respHeader;
			const 叉桥={readyState:WebSocket.OPEN,send(data){if(已关闭)return;try{controller.enqueue(数据转Uint8Array(data))}catch(e){已关闭=true;this.readyState=WebSocket.CLOSED}},close(){if(已关闭)return;已关闭=true;this.readyState=WebSocket.CLOSED;try{controller.close()}catch(e){}}};
			try{
				if(首包.协议==='trojan'){木马UDP上下文.目标主机=首包.hostname;木马UDP上下文.目标端口=首包.port}
				if(首包.rawData?.byteLength){if(首包.协议==='trojan')await 转发木马UDP数据(首包.rawData,叉桥,木马UDP上下文,request);else await forwardataudp(首包.rawData,叉桥,udpRespHeader,request);udpRespHeader=null}
				while(true){const {done,value}=await reader.read();if(done)break;if(!value||value.byteLength===0)continue;if(首包.协议==='trojan')await 转发木马UDP数据(value,叉桥,木马UDP上下文,request);else await forwardataudp(value,叉桥,udpRespHeader,request);udpRespHeader=null}
			}catch(err){}finally{try{木马UDP上下文.反代Socket?.close()}catch(e){}closeSocketQuietly(叉桥);try{reader.releaseLock()}catch(e){}}
		},
		cancel(){try{reader.releaseLock()}catch(e){}}
	}),{status:200,headers:responseHeaders});
}

async function 读取叉HTTP首包(reader,token){
	const decoder=new TextDecoder();
	const 尝试解析魏烈思=(data)=>{
		if(data.byteLength<18)return{状态:'need_more'};
		if(!UUID字节匹配(data,1,token))return{状态:'invalid'};
		const optLen=data[17],cmdIndex=18+optLen;
		if(data.byteLength<cmdIndex+4)return{状态:'need_more'};
		const cmd=data[cmdIndex];
		if(cmd!==1&&cmd!==2)return{状态:'invalid'};
		const port=(data[cmdIndex+1]<<8)|data[cmdIndex+2],addrType=data[cmdIndex+3];
		let hostname,headerLen;
		if(addrType===1){hostname=`${data[cmdIndex+4]}.${data[cmdIndex+5]}.${data[cmdIndex+6]}.${data[cmdIndex+7]}`;headerLen=cmdIndex+8}
		else if(addrType===2){const len=data[cmdIndex+4];hostname=decoder.decode(data.subarray(cmdIndex+5,cmdIndex+5+len));headerLen=cmdIndex+5+len}
		else return{状态:'invalid'};
		return{状态:'ok',结果:{协议:'vless',hostname,port,isUDP:cmd===2,rawData:data.subarray(headerLen),respHeader:new Uint8Array([data[0],0]),原始数据:null}};
	};
	const 尝试解析木马=(data)=>{
		const 密码哈希=sha224(token),密码哈希字节=new TextEncoder().encode(密码哈希);
		if(data.byteLength<58||data[56]!==0x0d||data[57]!==0x0a)return{状态:data.byteLength<58?'need_more':'invalid'};
		for(let i=0;i<56;i++)if(data[i]!==密码哈希字节[i])return{状态:'invalid'};
		const cmd=data[58];
		if(cmd!==1&&cmd!==3)return{状态:'invalid'};
		const atype=data[59];
		let hostname,cursor=60;
		if(atype===1){hostname=`${data[60]}.${data[61]}.${data[62]}.${data[63]}`;cursor=64}
		else if(atype===3){const len=data[60];hostname=decoder.decode(data.subarray(61,61+len));cursor=61+len}
		else return{状态:'invalid'};
		const port=(data[cursor]<<8)|data[cursor+1];
		return{状态:'ok',结果:{协议:'trojan',hostname,port,isUDP:cmd===3,rawData:data.subarray(cursor+4),原始数据:data,respHeader:null}};
	};
	let buffer=new Uint8Array(1024),offset=0;
	while(true){
		const {value,done}=await reader.read();
		if(done){if(offset===0)return null;break}
		const chunk=new Uint8Array(value);
		if(offset+chunk.byteLength>buffer.byteLength){const nb=new Uint8Array(Math.max(buffer.byteLength*2,offset+chunk.byteLength));nb.set(buffer.subarray(0,offset));buffer=nb}
		buffer.set(chunk,offset);offset+=chunk.byteLength;
		const 当前数据=buffer.subarray(0,offset);
		const 木马结果=尝试解析木马(当前数据);
		if(木马结果.状态==='ok')return{...木马结果.结果,reader};
		const 魏烈思结果=尝试解析魏烈思(当前数据);
		if(魏烈思结果.状态==='ok')return{...魏烈思结果.结果,reader};
		if(木马结果.状态==='invalid'&&魏烈思结果.状态==='invalid')return null;
	}
	return null;
}

async function forwardataTCP(host,portNum,rawData,ws,respHeader,remoteConnWrapper,yourUUID,request=null,反代上下文={},允许木马反代=false,木马反代首包数据=null,仅建立连接=false){
	const ctx反代IP=反代上下文.反代IP||'';
	const ctx代理类型=反代上下文.代理类型!==undefined?反代上下文.代理类型:null;
	const ctx代理参数=反代上下文.代理参数||{};
	const ctx反代兜底=反代上下文.反代兜底!==undefined?反代上下文.反代兜底:true;
	const TCP连接=创建请求TCP连接器(request);
	const 连接超时毫秒=1000;
	const 安装当前连接=async(socket,generation,downlinkDrain,retryFunc=null)=>{
		try{await downlinkDrain}catch(e){try{socket?.close?.()}catch(_){}throw e}
		if(remoteConnWrapper.generation!==generation||ws.readyState!==WebSocket.OPEN){try{socket?.close?.()}catch(e){}throw new Error('connection superseded')}
		remoteConnWrapper.socket=socket;
		if(仅建立连接)return socket;
		connectStreams(socket,ws,respHeader,retryFunc,()=>remoteConnWrapper.generation===generation&&remoteConnWrapper.socket===socket,remoteConnWrapper).catch(err=>{try{socket?.close?.()}catch(e){}closeSocketQuietly(ws)});
		return true;
	};
	async function 打开TCP连接(address,port){const remoteSock=TCP连接({hostname:address,port});await Promise.race([remoteSock.opened,new Promise((_,reject)=>setTimeout(()=>reject(new Error('连接超时')),连接超时毫秒))]);return remoteSock}
	async function 写入首包(remoteSock,data){if(有效数据长度(data)<=0)return;const writer=remoteSock.writable.getWriter();try{await writer.write(数据转Uint8Array(data))}finally{try{writer.releaseLock()}catch(e){}}}
	async function 并发打开候选连接(候选列表){
		if(候选列表.length===1)return{socket:await 打开TCP连接(候选列表[0].hostname,候选列表[0].port),candidate:候选列表[0]};
		const attempts=候选列表.map(c=>打开TCP连接(c.hostname,c.port).then(socket=>({socket,candidate:c})));
		const winner=await Promise.any(attempts);
		for(const a of attempts)a.then(({socket})=>{if(socket!==winner.socket)try{socket.close()}catch(e){}}).catch(()=>{});
		return winner;
	}
	async function connectDirect(address,port,data=null){const 候选列表=Array.from({length:TCP并发拨号数},(_,i)=>({hostname:address,port,attempt:i}));const 结果=await 并发打开候选连接(候选列表);await 写入首包(结果.socket,data);return 结果.socket}
	async function connectProxyIP(address,port,data=null){
		if(ctx反代IP){
			const 反代列表=解析地址端口(ctx反代IP,host,yourUUID);
			const 实际并发数=Math.max(1,Math.floor(反代并发拨号数||1));
			for(let i=0;i<反代列表.length;i+=实际并发数){
				const 候选=[];
				for(let j=0;j<实际并发数&&i+j<反代列表.length;j++)候选.push({hostname:反代列表[i+j][0],port:反代列表[i+j][1]});
				try{const 结果=await 并发打开候选连接(候选);await 写入首包(结果.socket,data);return 结果.socket}catch(err){}
			}
		}
		if(ctx反代兜底)return connectDirect(address,port,data);
		throw new Error('所有反代连接失败');
	}
	async function connecttoPry(允许发送首包=true){
		if(remoteConnWrapper.connectingPromise){await remoteConnWrapper.connectingPromise;return}
		const {generation,downlinkDrain}=开始TCP连接世代(remoteConnWrapper);
		const 首包数据=允许发送首包?rawData:null;
		const 任务=(async()=>{
			let newSocket=null;
			try{
				if(ctx代理类型==='socks5')newSocket=await socks5Connect(host,portNum,首包数据,TCP连接,ctx代理参数);
				else if(ctx代理类型==='http')newSocket=await httpConnect(host,portNum,首包数据,false,TCP连接,ctx代理参数);
				else if(ctx代理类型==='https')newSocket=await httpConnect(host,portNum,首包数据,true,TCP连接,ctx代理参数);
				else newSocket=await connectProxyIP(host,portNum,首包数据);
				await 安装当前连接(newSocket,generation,downlinkDrain);
			}catch(err){try{newSocket?.close?.()}catch(e){}if(remoteConnWrapper.generation===generation){remoteConnWrapper.socket=null;closeSocketQuietly(ws);throw err}}
		})();
		remoteConnWrapper.connectingPromise=任务;
		try{await 任务}finally{if(remoteConnWrapper.connectingPromise===任务)remoteConnWrapper.connectingPromise=null}
	}
	remoteConnWrapper.retryConnect=async()=>connecttoPry(true);
	if(ctx代理类型){try{await connecttoPry();if(仅建立连接)return remoteConnWrapper.socket}catch(err){throw err}}
	else{
		const 世代=开始TCP连接世代(remoteConnWrapper);
		try{
			const initialSocket=await connectDirect(host,portNum,rawData);
			await 安装当前连接(initialSocket,世代.generation,世代.downlinkDrain,async()=>{if(remoteConnWrapper.generation!==世代.generation)return;await connecttoPry()});
			if(仅建立连接)return initialSocket;
		}catch(err){
			if(remoteConnWrapper.generation!==世代.generation)throw err;
			if(ws.readyState!==WebSocket.OPEN)throw err;
			await connecttoPry();
			if(仅建立连接)return remoteConnWrapper.socket;
		}
	}
}

async function forwardataudp(udpChunk,webSocket,respHeader,request){
	const 请求数据=数据转Uint8Array(udpChunk);
	try{
		const TCP连接=创建请求TCP连接器(request);
		const tcpSocket=TCP连接({hostname:'8.8.4.4',port:53});
		const writer=tcpSocket.writable.getWriter();
		await writer.write(请求数据);writer.releaseLock();
		let 魏烈思Header=respHeader;
		await tcpSocket.readable.pipeTo(new WritableStream({
			async write(chunk){
				const 响应=数据转Uint8Array(chunk);
				if(webSocket.readyState!==WebSocket.OPEN)return;
				if(魏烈思Header){const merged=new Uint8Array(魏烈思Header.length+响应.byteLength);merged.set(魏烈思Header,0);merged.set(响应,魏烈思Header.length);await WebSocket发送并等待(webSocket,merged.buffer);魏烈思Header=null}
				else await WebSocket发送并等待(webSocket,响应);
			}
		}));
	}catch(error){}
}

const 反代协议默认端口={socks5:1080,http:80,https:443};
function 获取代理默认端口(类型){return 反代协议默认端口[类型]||80}
function 获取SOCKS5账号(address,默认端口=80){
	const raw=String(address||'').trim();
	if(!raw)throw new Error('代理地址为空');
	let authPart='',hostPart=raw;
	if(raw.includes('@')){const atIdx=raw.lastIndexOf('@');authPart=raw.slice(0,atIdx);hostPart=raw.slice(atIdx+1)}
	let hostname=hostPart,port=默认端口;
	if(hostPart.startsWith('[')){const m=hostPart.match(/^\[([^\]]+)\]:(\d+)$/);if(m){hostname=m[1];port=parseInt(m[2])}}
	else if(hostPart.includes(':')){const parts=hostPart.split(':');hostname=parts.slice(0,-1).join(':');port=parseInt(parts[parts.length-1])}
	let username='',password='';
	if(authPart.includes(':')){const idx=authPart.indexOf(':');username=authPart.slice(0,idx);password=authPart.slice(idx+1)}else username=authPart;
	return{username,password,hostname,port};
}
async function socks5Connect(targetHost,targetPort,initialData,TCP连接,parsedSocks5){
	const {username,password,hostname,port}=parsedSocks5;
	const socket=TCP连接({hostname,port});await socket.opened;
	const writer=socket.writable.getWriter();
	if(username&&password)await writer.write(new Uint8Array([5,1,2]));else await writer.write(new Uint8Array([5,1,0]));
	const reader=socket.readable.getReader();
	const {value:resp1}=await reader.read();
	if(resp1[1]===2){const authData=new Uint8Array([1,username.length,...new TextEncoder().encode(username),password.length,...new TextEncoder().encode(password)]);await writer.write(authData);const {value:authResp}=await reader.read();if(authResp[1]!==0)throw new Error('SOCKS5认证失败')}
	else if(resp1[1]!==0)throw new Error('SOCKS5握手失败');
	const targetBytes=new TextEncoder().encode(targetHost);
	await writer.write(new Uint8Array([5,1,0,3,targetBytes.length,...targetBytes,(targetPort>>8)&0xff,targetPort&0xff]));
	const {value:connectResp}=await reader.read();
	if(connectResp[1]!==0)throw new Error(`SOCKS5 CONNECT失败:${connectResp[1]}`);
	reader.releaseLock();
	if(initialData?.byteLength){const w=socket.writable.getWriter();await w.write(数据转Uint8Array(initialData));w.releaseLock()}
	return socket;
}
async function httpConnect(targetHost,targetPort,initialData,HTTPS代理=false,TCP连接,parsedSocks5){
	const {username,password,hostname,port}=parsedSocks5;
	const socket=TCP连接({hostname,port});await socket.opened;
	const writer=socket.writable.getWriter();
	let authHeader='';
	if(username&&password)authHeader=`Proxy-Authorization: Basic ${btoa(`${username}:${password}`)}\r\n`;
	await writer.write(new TextEncoder().encode(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${authHeader}\r\n`));
	const reader=socket.readable.getReader();
	let respBuf=new Uint8Array(0);
	while(true){const {value}=await reader.read();respBuf=拼接字节数据(respBuf,value);const headerEnd=respBuf.findIndex((_,i)=>i<respBuf.length-3&&respBuf[i]===0x0d&&respBuf[i+1]===0x0a&&respBuf[i+2]===0x0d&&respBuf[i+3]===0x0a);if(headerEnd!==-1)break}
	const statusLine=new TextDecoder().decode(respBuf).split('\r\n')[0];
	if(!statusLine.includes('200'))throw new Error(`HTTP代理CONNECT失败:${statusLine}`);
	reader.releaseLock();
	if(initialData?.byteLength){const w=socket.writable.getWriter();await w.write(数据转Uint8Array(initialData));w.releaseLock()}
	return socket;
}

const UUID字节缓存=new Map();
function 获取UUID字节(uuid){
	const key=String(uuid||'');
	let cached=UUID字节缓存.get(key);
	if(cached)return cached;
	const clean=key.replace(/-/g,'');
	if(clean.length!==32)return null;
	const bytes=new Uint8Array(16);
	for(let i=0;i<16;i++){const high=parseInt(clean[i*2],16),low=parseInt(clean[i*2+1],16);bytes[i]=(high<<4)|low}
	if(UUID字节缓存.size>=32)UUID字节缓存.clear();
	UUID字节缓存.set(key,bytes);
	return bytes;
}
function UUID字节匹配(data,offset,uuid){const expected=获取UUID字节(uuid);if(!expected||data.byteLength<offset+16)return false;for(let i=0;i<16;i++)if(data[offset+i]!==expected[i])return false;return true}
function 解析魏烈思请求(chunk,token){
	const data=数据转Uint8Array(chunk);
	if(data.byteLength<24)return{hasError:true,message:'Invalid data'};
	const version=data[0];
	if(!UUID字节匹配(data,1,token))return{hasError:true,message:'Invalid uuid'};
	const optLen=data[17],cmdIndex=18+optLen;
	if(data.byteLength<cmdIndex+4)return{hasError:true,message:'Invalid data'};
	const cmd=data[cmdIndex],isUDP=cmd===2;
	if(cmd!==1&&cmd!==2)return{hasError:true,message:'Invalid command'};
	const port=(data[cmdIndex+1]<<8)|data[cmdIndex+2],addressType=data[cmdIndex+3];
	let hostname,rawIndex;
	if(addressType===1){hostname=`${data[cmdIndex+4]}.${data[cmdIndex+5]}.${data[cmdIndex+6]}.${data[cmdIndex+7]}`;rawIndex=cmdIndex+8}
	else if(addressType===2){const len=data[cmdIndex+4];hostname=new TextDecoder().decode(data.subarray(cmdIndex+5,cmdIndex+5+len));rawIndex=cmdIndex+5+len}
	else if(addressType===3){const ipv6=[];for(let i=0;i<8;i++)ipv6.push(((data[cmdIndex+4+i*2]<<8)|data[cmdIndex+5+i*2]).toString(16));hostname=ipv6.join(':');rawIndex=cmdIndex+20}
	else return{hasError:true,message:`Invalid address type:${addressType}`};
	return{hasError:false,port,hostname,version,isUDP,rawClientData:data.subarray(rawIndex)};
}
function 解析木马请求(buffer,passwordPlainText){
	const data=数据转Uint8Array(buffer);
	const sha224Password=sha224(passwordPlainText);
	if(data.byteLength<58||data[56]!==0x0d||data[57]!==0x0a)return{hasError:true,message:'invalid trojan header'};
	const pwBytes=new TextEncoder().encode(sha224Password);
	for(let i=0;i<56;i++)if(data[i]!==pwBytes[i])return{hasError:true,message:'invalid trojan password'};
	const cmd=data[58];
	if(cmd!==1&&cmd!==3)return{hasError:true,message:'unsupported command'};
	const isUDP=cmd===3,atype=data[59];
	let hostname,cursor=60;
	if(atype===1){hostname=`${data[60]}.${data[61]}.${data[62]}.${data[63]}`;cursor=64}
	else if(atype===3){const len=data[60];hostname=new TextDecoder().decode(data.subarray(61,61+len));cursor=61+len}
	else if(atype===4){const ipv6=[];for(let i=0;i<8;i++)ipv6.push(((data[60+i*2]<<8)|data[61+i*2]).toString(16));hostname=ipv6.join(':');cursor=76}
	else return{hasError:true,message:'invalid address type'};
	const port=(data[cursor]<<8)|data[cursor+1];
	return{hasError:false,port,hostname,isUDP,rawClientData:data.subarray(cursor+4)};
}
function 解析木马反代地址(address){const raw=String(address||'').trim();const parts=raw.split(':');if(parts.length!==2)throw new Error('木马反代仅支持 host:port');return{hostname:parts[0],port:parseInt(parts[1])}}
async function 连接木马反代(首包数据,TCP连接,木马反代目标){
	if(!木马反代目标)throw new Error('trojan fallback not configured');
	const socket=TCP连接({hostname:木马反代目标.hostname,port:木马反代目标.port});
	await socket.opened;
	if(首包数据?.byteLength){const writer=socket.writable.getWriter();await writer.write(数据转Uint8Array(首包数据));writer.releaseLock()}
	return socket;
}
async function 转发木马UDP数据(chunk,webSocket,上下文,request){
	const 当前块=数据转Uint8Array(chunk);
	if(上下文?.反代地址)return 转发木马UDP反代数据(当前块,webSocket,上下文,request);
	const 缓存块=上下文?.缓存 instanceof Uint8Array?上下文.缓存:new Uint8Array(0);
	const input=缓存块.byteLength?拼接字节数据(缓存块,当前块):当前块;
	let cursor=0;
	while(cursor<input.byteLength){
		const atype=input[cursor];
		let addrCursor=cursor+1,addrLen=0;
		if(atype===1)addrLen=4;else if(atype===3){addrLen=1+input[addrCursor]}else if(atype===4)addrLen=16;else throw new Error('invalid trojan udp atype');
		const portCursor=addrCursor+addrLen;
		if(input.byteLength<portCursor+6)break;
		const port=(input[portCursor]<<8)|input[portCursor+1];
		const payloadLength=(input[portCursor+2]<<8)|input[portCursor+3];
		const payload=input.slice(portCursor+6,portCursor+6+payloadLength);
		cursor=portCursor+6+payloadLength;
		if(port!==53)throw new Error('UDP only supports DNS(53)');
		if(!payload.byteLength)continue;
		let tcpDNS=payload;
		if(payload.byteLength<2||((payload[0]<<8)|payload[1])!==payload.byteLength-2){tcpDNS=new Uint8Array(payload.byteLength+2);tcpDNS[0]=(payload.byteLength>>>8)&0xff;tcpDNS[1]=payload.byteLength&0xff;tcpDNS.set(payload,2)}
		await forwardataudp(tcpDNS,webSocket,null,request);
	}
	if(上下文)上下文.缓存=input.slice(cursor);
}
async function 转发木马UDP反代数据(chunk,webSocket,上下文,request){
	if(!上下文.反代Socket){const TCP连接=创建请求TCP连接器(request);上下文.反代Socket=await 连接木马反代(chunk,TCP连接,上下文.反代地址);connectStreams(上下文.反代Socket,webSocket,null,null);return}
	if(!chunk.byteLength)return;
	const writer=上下文.反代Socket.writable.getWriter();
	try{await writer.write(数据转Uint8Array(chunk))}finally{try{writer.releaseLock()}catch(e){}}
}

function 有效数据长度(data){if(!data)return 0;if(typeof data.byteLength==='number')return data.byteLength;if(typeof data.length==='number')return data.length;return 0}
function 失效TCP连接世代(remoteConnWrapper){if(!remoteConnWrapper)return;remoteConnWrapper.generation=(Number.isInteger(remoteConnWrapper.generation)?remoteConnWrapper.generation:0)+1;const socket=remoteConnWrapper.socket;remoteConnWrapper.socket=null;try{socket?.close?.()}catch(e){}}
function 开始TCP连接世代(remoteConnWrapper){if(!Number.isInteger(remoteConnWrapper.generation))remoteConnWrapper.generation=0;const generation=++remoteConnWrapper.generation;const previousSocket=remoteConnWrapper.socket;remoteConnWrapper.socket=null;const downlinkDrain=remoteConnWrapper.downlinkDrain||Promise.resolve();downlinkDrain.catch(()=>{});remoteConnWrapper.downlinkDrain=downlinkDrain;try{previousSocket?.close?.()}catch(e){}return{generation,downlinkDrain}}
function closeSocketQuietly(socket){try{if(socket.readyState===WebSocket.OPEN||socket.readyState===WebSocket.CLOSING)socket.close()}catch(e){}}
async function WebSocket发送并等待(webSocket,payload){const result=webSocket.send(payload);if(result&&typeof result.then==='function')await result}
function 创建上行Grain合包流(目标字节=上行合包目标字节){
	const identity=new TransformStream();
	const writer=identity.writable.getWriter();
	const 缓冲=new Uint8Array(目标字节);
	let 缓冲长度=0,定时器=null,在途写=null;
	const 串行写=async(chunk)=>{if(在途写)await 在途写;在途写=writer.write(chunk);try{await 在途写}finally{在途写=null}};
	const 冲刷=async()=>{if(缓冲长度){const chunk=缓冲.slice(0,缓冲长度);缓冲长度=0;await 串行写(chunk)}};
	return{
		readable:identity.readable,
		写入:async(chunk)=>{
			const data=数据转Uint8Array(chunk);
			if(!data.byteLength)return;
			if(data.byteLength>=目标字节){if(定时器)clearTimeout(定时器);if(缓冲长度)await 冲刷();await 串行写(data);return}
			if(缓冲长度+data.byteLength>=目标字节){const output=new Uint8Array(缓冲长度+data.byteLength);output.set(缓冲.subarray(0,缓冲长度));output.set(data,缓冲长度);缓冲长度=0;if(定时器)clearTimeout(定时器);await 串行写(output)}
			else{缓冲.set(data,缓冲长度);缓冲长度+=data.byteLength;if(!定时器)定时器=setTimeout(()=>{定时器=null;冲刷()},1)}
		},
		结束:async()=>{if(定时器)clearTimeout(定时器);try{await 冲刷();await writer.close()}finally{try{writer.releaseLock()}catch(e){}}}
	};
}
function 创建上行写入队列({获取写入器,获取连接任务=null,释放写入器,重试连接,关闭连接,名称='上行队列'}){
	let 队列=[],队列字节=0,draining=false,closed=false;
	const bundle=()=>{if(队列.length===0)return null;const total=队列.reduce((s,i)=>s+i.chunk.byteLength,0);const out=new Uint8Array(total);let off=0;for(const item of 队列){out.set(item.chunk,off);off+=item.chunk.byteLength}const result={chunk:out,allowRetry:队列.every(i=>i.allowRetry)};队列=[];队列字节=0;return result};
	const drain=async()=>{
		if(draining||closed)return;
		draining=true;
		try{
			while(!closed){
				const item=bundle();
				if(!item)break;
				let writer=获取写入器();
				if(!writer&&获取连接任务){await 获取连接任务();writer=获取写入器()}
				if(!writer)throw new Error(`${名称}: writer unavailable`);
				try{await writer.write(item.chunk)}
				catch(err){释放写入器?.();if(!item.allowRetry||typeof 重试连接!=='function')throw err;await 重试连接();writer=获取写入器();if(!writer)throw err;await writer.write(item.chunk)}
			}
		}catch(err){closed=true;队列=[];队列字节=0;try{关闭连接?.(err)}catch(_){}}
		finally{draining=false;if(!closed&&队列.length)drain()}
	};
	return{
		写入(data,allowRetry=true){if(closed)return false;if(!获取写入器()&&!获取连接任务)return false;const chunk=数据转Uint8Array(data);if(!chunk.byteLength)return true;if(队列字节+chunk.byteLength>上行队列最大字节||队列.length>=上行队列最大条目){closed=true;try{关闭连接?.()}catch(_){}return false}队列.push({chunk,allowRetry});队列字节+=chunk.byteLength;if(!draining)drain();return true},
		async 写入并等待(data,allowRetry=true){this.写入(data,allowRetry);while(draining||队列.length>0)await new Promise(r=>setTimeout(r,5));return true},
		清空(){closed=true;队列=[];队列字节=0}
	};
}
async function connectStreams(remoteSocket,webSocket,headerData,retryFunc,isCurrentSocket=null,remoteConnWrapper=null){
	let header=headerData,hasData=false;
	try{
		const reader=remoteSocket.readable.getReader();
		while(true){
			const {done,value}=await reader.read();
			if(done)break;
			if(!value||value.byteLength===0)continue;
			hasData=true;
			const chunk=数据转Uint8Array(value);
			if(header){const merged=new Uint8Array(header.length+chunk.byteLength);merged.set(header,0);merged.set(chunk,header.length);header=null;if(webSocket.readyState===WebSocket.OPEN)webSocket.send(merged)}
			else if(webSocket.readyState===WebSocket.OPEN)webSocket.send(chunk);
		}
	}catch(err){}
	finally{try{remoteSocket.close()}catch(e){}}
	if(!hasData&&retryFunc&&webSocket.readyState===WebSocket.OPEN&&(!isCurrentSocket||isCurrentSocket())){try{await retryFunc();return}catch(e){}}
	closeSocketQuietly(webSocket);
}

function 数据转Uint8Array(data){if(data instanceof Uint8Array)return data;if(data instanceof ArrayBuffer)return new Uint8Array(data);if(ArrayBuffer.isView(data))return new Uint8Array(data.buffer,data.byteOffset,data.byteLength);return new Uint8Array(data||0)}
function 拼接字节数据(...chunkList){if(!chunkList||chunkList.length===0)return new Uint8Array(0);const chunks=chunkList.map(数据转Uint8Array);const total=chunks.reduce((sum,c)=>sum+c.byteLength,0);const result=new Uint8Array(total);let offset=0;for(const c of chunks){result.set(c,offset);offset+=c.byteLength}return result}
function isSpeedTestSite(hostname){return['speed.cloudflare.com','cp.cloudflare.com'].some(d=>hostname.toLowerCase()===d||hostname.endsWith('.'+d))}
function 构造本地204响应(respHeader=null){const body=new TextEncoder().encode('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');if(!respHeader||respHeader.byteLength===0)return body;const merged=new Uint8Array(respHeader.byteLength+body.byteLength);merged.set(数据转Uint8Array(respHeader),0);merged.set(body,respHeader.byteLength);return merged}
function 构造WS本地204响应(respHeader=null){const body=new TextEncoder().encode('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n');if(!respHeader||respHeader.byteLength===0)return body;const merged=new Uint8Array(respHeader.byteLength+body.byteLength);merged.set(数据转Uint8Array(respHeader),0);merged.set(body,respHeader.byteLength);return merged}
function 创建请求TCP连接器(request){return(options)=>connect(options)}
function 解析地址端口(proxyIP,目标域名,UUID){const 列表=整理成数组(proxyIP);const 结果=[];for(const item of 列表){const clean=item.trim();if(!clean)continue;if(clean.includes(':')){const parts=clean.split(':');结果.push([parts.slice(0,-1).join(':'),parseInt(parts[parts.length-1])])}else 结果.push([clean,443])}return 结果}
function 整理成数组(内容){if(!内容)return[];if(Array.isArray(内容))return 内容;if(typeof 内容==='string')return 内容.split(/[,;\n\r]+/).map(s=>s.trim()).filter(Boolean);return[内容]}
function log(...args){if(调试日志打印)console.log(...args)}
