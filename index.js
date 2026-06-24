require('dotenv').config();

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode-terminal');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// ── Configurações ──
const CONFIG = {
    MAX_RECONNECT_TENTATIVAS: 5,
    RECONNECT_DELAY_MS: 5000,
    OPERATION_TIMEOUT_MS: 60000,
    BULK_DELAY_MS: 1500,
    MAX_BODY_SIZE: '50mb',
    RETRY_TENTATIVAS: 3,
};

const app = express();
app.use(cors());
app.use(express.json({ limit: CONFIG.MAX_BODY_SIZE }));
app.use(express.urlencoded({ limit: CONFIG.MAX_BODY_SIZE, extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Estado da aplicação ──
let clientReady = false;
let clientInitialized = false;
let lastQr = null;
let statusMessage = 'Inicializando...';
let reconnectTentativas = 0;
let totalMensagensEnviadas = 0;
let totalErros = 0;
let ultimoErro = null;
let startTime = new Date();

// ── Sistema de bloqueio de contatos ──
const BLOCKLIST_FILE = path.join(__dirname, 'blocklist.json');
let blockedContacts = new Set();

function loadBlocklist() {
    try {
        if (fs.existsSync(BLOCKLIST_FILE)) {
            const data = JSON.parse(fs.readFileSync(BLOCKLIST_FILE, 'utf8'));
            blockedContacts = new Set(data.numeros || []);
            console.log(`[BLOCKLIST] ${blockedContacts.size} contato(s) bloqueado(s) carregado(s)`);
        }
    } catch (err) {
        console.error('[BLOCKLIST] Erro ao carregar:', err.message);
        blockedContacts = new Set();
    }
}

function saveBlocklist() {
    try {
        fs.writeFileSync(BLOCKLIST_FILE, JSON.stringify({ numeros: [...blockedContacts] }, null, 2));
    } catch (err) {
        console.error('[BLOCKLIST] Erro ao salvar:', err.message);
    }
}

function isBlocked(numero) {
    const limpo = String(numero).replace(/\D/g, '');
    return blockedContacts.has(limpo);
}

loadBlocklist();

// ── Cache de contatos ──
let contactsCache = [];
let contactsCacheTime = 0;
const CONTACTS_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// ── Handlers globais de erro ──
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Erro não capturado:', err.message, err.stack);
    totalErros++;
    ultimoErro = { tipo: 'uncaughtException', mensagem: err.message, timestamp: new Date().toISOString() };
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Promise rejeitada não tratada:', reason);
    totalErros++;
    ultimoErro = { tipo: 'unhandledRejection', mensagem: String(reason).slice(0, 500), timestamp: new Date().toISOString() };
});

// Erro no Express
app.use((err, req, res, next) => {
    console.error('[EXPRESS] Erro:', err.message);

    if (err.type === 'entity.too.large') {
        return res.status(413).json({
            success: false,
            error: 'Payload muito grande. Máximo: 50MB',
            detalhes: err.message
        });
    }

    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({
            success: false,
            error: 'JSON inválido no corpo da requisição',
            detalhes: err.message
        });
    }

    res.status(err.status || 500).json({
        success: false,
        error: 'Erro interno do servidor',
        detalhes: process.env.NODE_ENV === 'development' ? err.message : 'Erro inesperado'
    });
});

// ── Cliente WhatsApp ──
function criarCliente() {
    return new Client({
        authStrategy: new LocalAuth({ dataPath: './session' }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-sync'
            ]
        },
        takeoverOnConflict: true,
        takeoverTimeoutMs: 30000,
        restartOnAuthFail: true,
    });
}

let client = criarCliente();

function setupClientEvents() {
    client.on('qr', (qr) => {
        lastQr = qr;
        reconnectTentativas = 0;
        statusMessage = 'QR Code gerado - escaneie para autenticar';
        console.log('[QR] Escaneie o QR Code abaixo:');
        qrcode.generate(qr, { small: true });
    });

    client.on('authenticated', () => {
        statusMessage = 'Sessão autenticada com sucesso';
        console.log('[AUTH] Sessão autenticada');
    });

    client.on('auth_failure', (msg) => {
        statusMessage = 'Falha na autenticação';
        clientReady = false;
        totalErros++;
        ultimoErro = { tipo: 'auth_failure', mensagem: msg, timestamp: new Date().toISOString() };
        console.error('[AUTH] Falha na autenticação:', msg);
    });

    client.on('ready', () => {
        clientReady = true;
        clientInitialized = true;
        statusMessage = 'Cliente WhatsApp pronto e conectado';
        console.log('[READY] Cliente WhatsApp pronto');
    });

    client.on('disconnected', async (reason) => {
        clientReady = false;
        statusMessage = `Desconectado: ${reason}`;
        totalErros++;
        console.log('[DISCONNECT]', reason);

        if (reason === 'NAVIGATION' || reason === 'LOGOUT') {
            ultimoErro = { tipo: 'disconnected_logout', mensagem: reason, timestamp: new Date().toISOString() };
            console.log('[DISCONNECT] Logout detectado. Aguardando novo QR Code manual.');
            return;
        }

        tentarReconectar();
    });

    client.on('change_state', (state) => {
        console.log('[STATE] Mudança de estado:', state);
    });

    client.on('loading_screen', (percent, message) => {
        console.log(`[LOADING] ${percent}% - ${message}`);
    });

    client.on('message', async (msg) => {
        try {
            if (!clientReady) return;
            await handleIncomingMessage(msg);
        } catch (err) {
            console.error('[ASSISTENTE] Erro ao processar mensagem:', err.message);
        }
    });
}

async function tentarReconectar() {
    if (reconnectTentativas >= CONFIG.MAX_RECONNECT_TENTATIVAS) {
        statusMessage = `Falha após ${CONFIG.MAX_RECONNECT_TENTATIVAS} tentativas de reconexão - aguardando intervenção manual`;
        console.error('[RECONNECT] Máximo de tentativas excedido');
        ultimoErro = { tipo: 'max_reconnect', mensagem: 'Tentativas esgotadas', timestamp: new Date().toISOString() };
        return;
    }

    reconnectTentativas++;
    const delay = CONFIG.RECONNECT_DELAY_MS * reconnectTentativas;
    statusMessage = `Reconectando... tentativa ${reconnectTentativas}/${CONFIG.MAX_RECONNECT_TENTATIVAS} em ${delay / 1000}s`;
    console.log(`[RECONNECT] Tentativa ${reconnectTentativas} em ${delay / 1000}s`);

    await sleep(delay);

    try {
        await client.destroy().catch(() => {});
        client = criarCliente();
        setupClientEvents();
        await client.initialize();
    } catch (err) {
        console.error('[RECONNECT] Falha ao reconectar:', err.message);
        ultimoErro = { tipo: 'reconnect_fail', mensagem: err.message, timestamp: new Date().toISOString() };
        tentarReconectar();
    }
}

setupClientEvents();

console.log('[INIT] Iniciando cliente WhatsApp...');
client.initialize().catch(err => {
    statusMessage = `Erro ao inicializar: ${err.message}`;
    console.error('[INIT] Erro ao inicializar:', err.message);
    ultimoErro = { tipo: 'init_error', mensagem: err.message, timestamp: new Date().toISOString() };
    setTimeout(() => tentarReconectar(), CONFIG.RECONNECT_DELAY_MS);
});

// ── Assistente Virtual Igor Dev ──
const conversations = new Map();

function getConv(chatId) {
    if (!conversations.has(chatId)) {
        conversations.set(chatId, { step: 'idle', data: {} });
    }
    return conversations.get(chatId);
}

async function enviarPlanilha(nome, email) {
    const PLANILHA_PATH = process.env.PLANILHA_PATH || '/root/planilha-gratuita.xlsx';

    try {
        const http = require('http');
        const fs = require('fs');

        if (!fs.existsSync(PLANILHA_PATH)) {
            console.error(`[ASSISTENTE] Arquivo da planilha não encontrado: ${PLANILHA_PATH}`);
            return false;
        }

        const arquivo = fs.readFileSync(PLANILHA_PATH);
        const base64 = arquivo.toString('base64');

        const data = JSON.stringify({
            para: email,
            assunto: 'Sua planilha gratuita - Igor Dev',
            corpo: `Olá ${nome},\n\nSegue em anexo a planilha gratuita que você solicitou.\n\nQualquer dúvida, estamos à disposição.\n\nAtenciosamente,\nIgor Dev`,
            anexos: [{
                filename: 'planilha-igor-dev.xlsx',
                content: base64,
                encoding: 'base64',
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            }]
        });

        return new Promise((resolve) => {
            const req = http.request({
                hostname: 'localhost',
                port: 3001,
                path: '/api/enviar-email-anexo',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
                timeout: 30000,
            }, (res) => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(body);
                        resolve(json.success === true);
                    } catch (e) {
                        resolve(false);
                    }
                });
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.write(data);
            req.end();
        });
    } catch (err) {
        console.error('[ASSISTENTE] Erro ao enviar planilha:', err.message);
        return false;
    }
}

async function handleIncomingMessage(msg) {
    if (msg.from === 'status@broadcast' || msg.isStatus) return;
    if (msg.fromMe) return;
    if (!msg.body || msg.body.trim().length === 0) return;

    const chatId = msg.from;

    // Verifica se o contato está bloqueado
    if (isBlocked(chatId.replace('@c.us', ''))) return;

    const texto = msg.body.trim();
    const conv = getConv(chatId);

    if (conv.step === 'closing') {
        const horas = (Date.now() - conv.closedAt) / (1000 * 60 * 60);
        if (horas >= 3) {
            conversations.delete(chatId);
        } else {
            return;
        }
    }

    const textoLower = texto.toLowerCase();
    const isPlanilha = textoLower.includes('planilha gratuita') || textoLower.includes('planilha gratis');

    if (conv.step === 'idle' && isPlanilha) {
        conv.step = 'planilha_waiting_name';
        conv.data = {};
        await msg.reply(
            'Olá! 👋\n\n' +
            'Vi que você tem interesse na *planilha gratuita*.\n\n' +
            'Para enviarmos, qual o *seu nome*?'
        );
        return;
    }

    if (conv.step === 'planilha_waiting_name') {
        conv.data.nome = texto;
        conv.step = 'planilha_waiting_email';
        await msg.reply(`Obrigado, *${texto}*!\n\nPara qual *e-mail* devemos enviar a planilha?`);
        return;
    }

    if (conv.step === 'planilha_waiting_email') {
        conv.data.email = texto.trim().toLowerCase();
        conv.step = 'closing';
        conv.closedAt = Date.now();

        const enviado = await enviarPlanilha(conv.data.nome, conv.data.email);

        if (enviado) {
            console.log(`[ASSISTENTE] Planilha enviada: ${conv.data.nome} | ${conv.data.email}`);
            await msg.reply(
                `Pronto, *${conv.data.nome}*! ✅\n\n` +
                `A planilha foi enviada para *${conv.data.email}*.\n\n` +
                'Confira a caixa de entrada e a de spam.\n\n' +
                'Qualquer dúvida, estamos à disposição!'
            );
        } else {
            await msg.reply(
                `*${conv.data.nome}*, houve um problema no envio. 😕\n\n` +
                'Vou avisar o Igor para enviar a planilha manualmente para você. Aguarde!'
            );
        }
        return;
    }

    if (conv.step === 'idle') {
        let contact = null;
        try { contact = await msg.getContact(); } catch (e) {}

        const nomeAgenda = contact ? (contact.name || contact.pushname || '') : '';
        const isSaved = contact ? contact.isMyContact : false;

        conv.data = {
            numero: contact ? contact.number : chatId.replace('@c.us', ''),
            salvo_na_agenda: isSaved,
            nome_agenda: nomeAgenda,
        };

        console.log(`[ASSISTENTE] Contato: ${conv.data.numero} | Salvo: ${isSaved} | Nome: ${nomeAgenda || '-'}`);

        if (isSaved && nomeAgenda) {
            conv.data.nome = nomeAgenda;
            conv.step = 'waiting_need';
            await msg.reply(
                `Olá, *${nomeAgenda}*!\n\n` +
                'Agradecemos o seu contato com a *Igor Dev*.\n\n' +
                'Como podemos ajudá-lo hoje? Descreva brevemente a sua necessidade ou o projeto que deseja discutir.'
            );
        } else {
            conv.step = 'waiting_name';
            await msg.reply(
                'Olá!\n\n' +
                'Obrigado por entrar em contato com a *Igor Dev*.\n\n' +
                'Para prosseguirmos, poderia nos informar o *seu nome*, por favor?'
            );
        }
        return;
    }

    if (conv.step === 'waiting_name') {
        conv.data.nome = texto;
        conv.step = 'waiting_need';
        await msg.reply(
            `Prazer, *${texto}*!\n\n` +
            'Como podemos ajudá-lo? Descreva brevemente a sua necessidade ou o projeto que deseja discutir.'
        );
        return;
    }

    if (conv.step === 'waiting_need') {
        conv.data.necessidade = texto;
        conv.step = 'closing';
        conv.closedAt = Date.now();

        const nome = conv.data.nome || conv.data.nome_agenda || 'Cliente';
        const salvo = conv.data.salvo_na_agenda ? '✅ Salvo na agenda' : '❌ Não salvo';

        console.log('[ASSISTENTE] Atendimento finalizado:');
        console.log(`  Nome: ${nome}`);
        console.log(`  Número: +${conv.data.numero}`);
        console.log(`  Agenda: ${salvo}`);
        console.log(`  Necessidade: ${conv.data.necessidade}`);

        await msg.reply(
            'Recebemos sua solicitação. ✅\n\n' +
            'O Igor analisará o seu caso com atenção e retornará com a melhor proposta em breve.\n\n' +
            'Agradecemos o contato e estamos à disposição.'
        );
        return;
    }
}

// ── Timeout helper ──
function comTimeout(promise, ms, label = '') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout (${ms / 1000}s)${label ? ' - ' + label : ''}`)), ms)
        )
    ]);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Analisa erros do WhatsApp ──
function analisarErroWhatsapp(error, numero) {
    const msg = error.message || String(error);
    const lower = msg.toLowerCase();

    if (lower.includes('not a valid') || lower.includes('invalid') || lower.includes('not exist')) {
        return {
            tipo: 'NUMERO_INVALIDO',
            mensagem: `O número ${numero || 'fornecido'} não é válido ou não está registrado no WhatsApp`,
            acao: 'Verifique o formato do número (código do país + DDD + número)'
        };
    }
    if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout')) {
        return {
            tipo: 'TIMEOUT',
            mensagem: 'A operação excedeu o tempo limite',
            acao: 'Tente novamente. O WhatsApp pode estar lento.'
        };
    }
    if (lower.includes('rate') || lower.includes('spam') || lower.includes('block') || lower.includes('limit')) {
        return {
            tipo: 'RATE_LIMIT',
            mensagem: 'Você atingiu o limite de envios do WhatsApp. Aguarde antes de enviar mais.',
            acao: 'Espere alguns minutos e tente novamente. Reduza a frequência de envios.'
        };
    }
    if (lower.includes('not ready') || lower.includes('disconnected') || lower.includes('no session')) {
        return {
            tipo: 'NAO_CONECTADO',
            mensagem: 'Cliente WhatsApp não está conectado',
            acao: 'Verifique o status em /api/status. Pode ser necessário escanear o QR Code.'
        };
    }
    if (lower.includes('ecxn')) {
        return {
            tipo: 'CONEXAO',
            mensagem: 'Erro de conexão com o WhatsApp',
            acao: 'Verifique a conectividade de rede do servidor.'
        };
    }
    if (lower.includes('too large') || lower.includes('size')) {
        return {
            tipo: 'ARQUIVO_GRANDE',
            mensagem: 'O arquivo é muito grande para envio via WhatsApp',
            acao: 'Reduza o tamanho do arquivo (máx ~64MB para documentos, ~16MB para mídia).'
        };
    }

    return {
        tipo: 'ERRO_DESCONHECIDO',
        mensagem: msg.slice(0, 300),
        acao: 'Verifique os logs do servidor para mais detalhes.'
    };
}

// ── Middleware de verificação ──
function requireReady(req, res, next) {
    if (!clientReady) {
        return res.status(503).json({
            success: false,
            error: 'Cliente WhatsApp não está pronto',
            status: statusMessage,
            dica: 'Escaneie o QR Code ou aguarde a conexão',
            pronto: false
        });
    }
    next();
}

// ── Validador de número ──
function validarNumero(numero) {
    const limpo = String(numero).replace(/\D/g, '');

    if (limpo.length < 10 || limpo.length > 15) {
        return { valido: false, erro: 'Número deve ter entre 10 e 15 dígitos (com código do país)' };
    }

    if (!/^\d+$/.test(limpo)) {
        return { valido: false, erro: 'Número contém caracteres inválidos' };
    }

    return { valido: true, limpo };
}

// ── ROTAS DA API ──

// Health check detalhado
app.get('/api/status', (req, res) => {
    const uptime = Math.floor((new Date() - startTime) / 1000);

    res.json({
        success: true,
        pronto: clientReady,
        inicializado: clientInitialized,
        status: statusMessage,
        stats: {
            uptime_segundos: uptime,
            mensagens_enviadas: totalMensagensEnviadas,
            erros_total: totalErros,
            reconnect_tentativas: reconnectTentativas,
            ultimo_erro: ultimoErro
        },
        timestamp: new Date().toISOString()
    });
});

// Obter QR Code
app.get('/api/qr', (req, res) => {
    if (clientReady) {
        return res.json({
            success: true,
            mensagem: 'Cliente já está autenticado e conectado',
            qr: null,
            pronto: true
        });
    }
    if (!lastQr) {
        return res.json({
            success: false,
            mensagem: 'QR Code ainda não foi gerado. Aguarde...',
            qr: null
        });
    }
    res.json({
        success: true,
        mensagem: 'Escaneie este QR Code no WhatsApp Web',
        qr: lastQr,
        pronto: false
    });
});

// ── UTILITÁRIO DE ENVIO COM RETRY ──
async function enviarComRetry(fnEnvio, maxRetries = CONFIG.RETRY_TENTATIVAS) {
    let ultimoErro;

    for (let i = 0; i < maxRetries; i++) {
        try {
            return await comTimeout(fnEnvio(), CONFIG.OPERATION_TIMEOUT_MS, `tentativa ${i + 1}`);
        } catch (err) {
            ultimoErro = err;
            const analise = analisarErroWhatsapp(err);

            if (analise.tipo === 'NUMERO_INVALIDO' || analise.tipo === 'ARQUIVO_GRANDE') {
                throw err;
            }

            if (i < maxRetries - 1) {
                const delay = Math.pow(2, i) * 1000;
                console.log(`[RETRY] Tentativa ${i + 1} falhou. Retentando em ${delay}ms...`);
                await sleep(delay);
            }
        }
    }

    throw ultimoErro;
}

// Enviar mensagem de texto
app.post('/api/enviar-mensagem', requireReady, async (req, res) => {
    try {
        const { numero, mensagem } = req.body;

        if (!numero || !mensagem) {
            return res.status(400).json({
                success: false,
                error: 'Campos obrigatórios: "numero" e "mensagem"'
            });
        }

        const validacao = validarNumero(numero);
        if (!validacao.valido) {
            return res.status(400).json({ success: false, error: validacao.erro });
        }

        if (typeof mensagem !== 'string' || mensagem.trim().length === 0) {
            return res.status(400).json({ success: false, error: 'Mensagem não pode estar vazia' });
        }

        if (mensagem.length > 4096) {
            return res.status(400).json({ success: false, error: 'Mensagem muito longa (máx 4096 caracteres)' });
        }

        const numeroFormatado = formatarNumero(validacao.limpo);

        const msgEnviada = await enviarComRetry(async () => {
            const chat = await client.getChatById(numeroFormatado);
            return await chat.sendMessage(mensagem);
        });

        totalMensagensEnviadas++;

        res.json({
            success: true,
            mensagem: 'Mensagem enviada com sucesso',
            dados: {
                id: msgEnviada.id._serialized,
                numero: numeroFormatado,
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        const analise = analisarErroWhatsapp(error, req.body.numero);
        totalErros++;
        console.error('[ERRO] Envio de mensagem:', analise.tipo, error.message);
        res.status(500).json({
            success: false,
            error: analise.mensagem,
            tipo: analise.tipo,
            acao: analise.acao,
            detalhes: error.message
        });
    }
});

// Enviar mensagem para múltiplos números (bulk)
app.post('/api/enviar-mensagem-bulk', requireReady, async (req, res) => {
    try {
        const { numeros, mensagem } = req.body;

        if (!numeros || !Array.isArray(numeros) || !mensagem) {
            return res.status(400).json({
                success: false,
                error: 'Campos obrigatórios: "numeros" (array) e "mensagem" (string)'
            });
        }

        if (numeros.length === 0) {
            return res.status(400).json({ success: false, error: 'Array "numeros" está vazio' });
        }

        if (numeros.length > 1000) {
            return res.status(400).json({ success: false, error: 'Máximo de 1000 números por lote' });
        }

        const resultados = [];
        let enviadosCount = 0;
        let errosCount = 0;

        for (let i = 0; i < numeros.length; i++) {
            const numero = numeros[i];

            try {
                const validacao = validarNumero(numero);

                if (!validacao.valido) {
                    resultados.push({ numero, status: 'numero_invalido', erro: validacao.erro });
                    errosCount++;
                    continue;
                }

                const numeroFormatado = formatarNumero(validacao.limpo);

                const msgEnviada = await enviarComRetry(async () => {
                    const chat = await client.getChatById(numeroFormatado);
                    return await chat.sendMessage(mensagem);
                }, 2);

                resultados.push({ numero: numeroFormatado, status: 'enviado', id: msgEnviada.id._serialized });
                enviadosCount++;
                totalMensagensEnviadas++;
            } catch (err) {
                const analise = analisarErroWhatsapp(err, numero);
                resultados.push({ numero, status: 'erro', erro: analise.mensagem, tipo: analise.tipo });
                errosCount++;

                if (analise.tipo === 'RATE_LIMIT') {
                    console.log('[BULK] Rate limit detectado. Pausando 10s...');
                    await sleep(10000);
                }
            }

            if (i < numeros.length - 1) {
                await sleep(CONFIG.BULK_DELAY_MS);
            }
        }

        res.json({
            success: true,
            mensagem: `${enviadosCount} de ${numeros.length} enviadas com sucesso`,
            resumo: { total: numeros.length, enviados: enviadosCount, erros: errosCount },
            resultados
        });
    } catch (error) {
        totalErros++;
        res.status(500).json({
            success: false,
            error: 'Erro ao processar lote',
            detalhes: error.message
        });
    }
});

// ── Envio de mídia (genérico) ──
app.post('/api/enviar-midia', requireReady, async (req, res) => {
    await handleMidia(req, res);
});

app.post('/api/enviar-imagem', requireReady, async (req, res) => {
    req.body.tipo = 'imagem';
    await handleMidia(req, res);
});

app.post('/api/enviar-audio', requireReady, async (req, res) => {
    req.body.tipo = 'audio';
    await handleMidia(req, res);
});

app.post('/api/enviar-video', requireReady, async (req, res) => {
    req.body.tipo = 'video';
    await handleMidia(req, res);
});

app.post('/api/enviar-documento', requireReady, async (req, res) => {
    req.body.tipo = 'documento';
    await handleMidia(req, res);
});

app.post('/api/enviar-sticker', requireReady, async (req, res) => {
    req.body.tipo = 'sticker';
    await handleMidia(req, res);
});

async function handleMidia(req, res) {
    try {
        const { numero, url, base64, mimetype, filename, legenda } = req.body;
        let { tipo } = req.body;

        if (!numero) {
            return res.status(400).json({ success: false, error: 'Campo "numero" é obrigatório' });
        }

        const validacao = validarNumero(numero);
        if (!validacao.valido) {
            return res.status(400).json({ success: false, error: validacao.erro });
        }

        if (!tipo) {
            return res.status(400).json({ success: false, error: 'Campo "tipo" é obrigatório' });
        }

        tipo = tipo.toLowerCase();

        const tiposValidos = ['imagem', 'image', 'audio', 'video', 'documento', 'document', 'sticker'];
        if (!tiposValidos.includes(tipo)) {
            return res.status(400).json({
                success: false,
                error: `Tipo "${tipo}" inválido`,
                tipos_validos: tiposValidos
            });
        }

        if (!url && !base64) {
            return res.status(400).json({ success: false, error: 'Forneça "url" ou "base64"' });
        }

        if (base64 && base64.length > 70 * 1024 * 1024) {
            return res.status(400).json({ success: false, error: 'Base64 muito grande (máximo ~50MB após decode)' });
        }

        const numeroFormatado = formatarNumero(validacao.limpo);
        let media;

        try {
            if (base64) {
                const mime = mimetype || mimePorTipo(tipo);
                media = new MessageMedia(mime, base64, filename || nomePadrao(tipo));
            } else {
                media = await comTimeout(
                    MessageMedia.fromUrl(url, { unsafeMime: true }),
                    30000,
                    'download da mídia'
                );
            }
        } catch (err) {
            return res.status(400).json({
                success: false,
                error: 'Falha ao obter mídia. Verifique a URL ou base64.',
                detalhes: err.message
            });
        }

        const msgEnviada = await enviarComRetry(async () => {
            const chat = await client.getChatById(numeroFormatado);

            switch (tipo) {
                case 'imagem':
                case 'image':
                    return await chat.sendMessage(media, { caption: legenda || '' });
                case 'audio':
                    return await chat.sendMessage(media, { sendAudioAsVoice: true });
                case 'video':
                    return await chat.sendMessage(media, { caption: legenda || '' });
                case 'documento':
                case 'document':
                    return await chat.sendMessage(media, { sendMediaAsDocument: true, caption: legenda || '' });
                case 'sticker':
                    return await chat.sendMessage(media, { sendMediaAsSticker: true });
                default:
                    throw new Error(`Tipo não mapeado: ${tipo}`);
            }
        });

        totalMensagensEnviadas++;

        res.json({
            success: true,
            mensagem: `${tipo} enviado com sucesso`,
            dados: { id: msgEnviada.id._serialized, numero: numeroFormatado, tipo }
        });

    } catch (error) {
        const analise = analisarErroWhatsapp(error, req.body.numero);
        totalErros++;
        console.error(`[ERRO] Envio de mídia (${req.body.tipo}):`, analise.tipo, error.message);
        res.status(500).json({
            success: false,
            error: analise.mensagem,
            tipo: analise.tipo,
            acao: analise.acao,
            detalhes: error.message
        });
    }
}

// ── Envio de mídia em lote ──
app.post('/api/enviar-midia-bulk', requireReady, async (req, res) => {
    try {
        const { numeros, tipo, url, base64, mimetype, filename, legenda } = req.body;

        if (!numeros || !Array.isArray(numeros)) {
            return res.status(400).json({ success: false, error: 'Campo "numeros" (array) é obrigatório' });
        }

        if (numeros.length === 0) {
            return res.status(400).json({ success: false, error: 'Array "numeros" está vazio' });
        }

        if (numeros.length > 500) {
            return res.status(400).json({ success: false, error: 'Máximo de 500 números por lote de mídia' });
        }

        const resultados = [];
        let enviadosCount = 0;

        for (let i = 0; i < numeros.length; i++) {
            const numero = numeros[i];

            const fakeReq = { body: { numero, tipo, url, base64, mimetype, filename, legenda } };
            let fakeRes = { _status: null, _json: null };

            const originalJson = res.json.bind(res);
            let capturado = null;

            await handleMidiaInternal(fakeReq, async (status, json) => {
                capturado = { status, json };
            });

            if (capturado && capturado.json && capturado.json.success) {
                resultados.push({ numero, status: 'enviado', id: capturado.json.dados?.id });
                enviadosCount++;
            } else {
                resultados.push({
                    numero,
                    status: 'erro',
                    erro: capturado?.json?.error || 'Erro desconhecido',
                    tipo: capturado?.json?.tipo
                });
            }

            if (i < numeros.length - 1) {
                await sleep(CONFIG.BULK_DELAY_MS);
            }
        }

        res.json({
            success: true,
            mensagem: `${enviadosCount} de ${numeros.length} mídias enviadas`,
            resumo: { total: numeros.length, enviados: enviadosCount, erros: numeros.length - enviadosCount },
            resultados
        });
    } catch (error) {
        totalErros++;
        res.status(500).json({ success: false, error: 'Erro ao processar lote de mídia', detalhes: error.message });
    }
});

// Versão interna do handleMidia que não depende de req/res Express
async function handleMidiaInternal(req, callback) {
    try {
        const { numero, url, base64, mimetype, filename, legenda } = req.body;
        let { tipo } = req.body;

        if (!numero || !tipo) {
            return callback(400, { success: false, error: 'numero e tipo obrigatórios' });
        }

        const validacao = validarNumero(numero);
        if (!validacao.valido) {
            return callback(400, { success: false, error: validacao.erro });
        }

        tipo = tipo.toLowerCase();

        if (!url && !base64) {
            return callback(400, { success: false, error: 'Forneça url ou base64' });
        }

        const numeroFormatado = formatarNumero(validacao.limpo);
        let media;

        try {
            if (base64) {
                const mime = mimetype || mimePorTipo(tipo);
                media = new MessageMedia(mime, base64, filename || nomePadrao(tipo));
            } else {
                media = await comTimeout(MessageMedia.fromUrl(url, { unsafeMime: true }), 30000, 'download');
            }
        } catch (err) {
            return callback(400, { success: false, error: 'Falha ao obter mídia', detalhes: err.message });
        }

        const msgEnviada = await enviarComRetry(async () => {
            const chat = await client.getChatById(numeroFormatado);

            switch (tipo) {
                case 'imagem':
                case 'image':
                    return await chat.sendMessage(media, { caption: legenda || '' });
                case 'audio':
                    return await chat.sendMessage(media, { sendAudioAsVoice: true });
                case 'video':
                    return await chat.sendMessage(media, { caption: legenda || '' });
                case 'documento':
                case 'document':
                    return await chat.sendMessage(media, { sendMediaAsDocument: true, caption: legenda || '' });
                case 'sticker':
                    return await chat.sendMessage(media, { sendMediaAsSticker: true });
                default:
                    throw new Error(`Tipo não mapeado: ${tipo}`);
            }
        });

        totalMensagensEnviadas++;
        callback(200, { success: true, dados: { id: msgEnviada.id._serialized, numero: numeroFormatado, tipo } });
    } catch (error) {
        const analise = analisarErroWhatsapp(error, req.body.numero);
        totalErros++;
        callback(500, { success: false, error: analise.mensagem, tipo: analise.tipo, acao: analise.acao });
    }
}

// Enviar localização
app.post('/api/enviar-localizacao', requireReady, async (req, res) => {
    try {
        const { numero, latitude, longitude, nome, endereco } = req.body;

        if (!numero || latitude == null || longitude == null) {
            return res.status(400).json({ success: false, error: 'Campos obrigatórios: "numero", "latitude", "longitude"' });
        }

        const validacao = validarNumero(numero);
        if (!validacao.valido) {
            return res.status(400).json({ success: false, error: validacao.erro });
        }

        const lat = parseFloat(latitude);
        const lng = parseFloat(longitude);

        if (isNaN(lat) || isNaN(lng)) {
            return res.status(400).json({ success: false, error: 'Latitude/longitude devem ser números válidos' });
        }

        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            return res.status(400).json({ success: false, error: 'Latitude (-90 a 90) ou longitude (-180 a 180) fora do intervalo' });
        }

        const numeroFormatado = formatarNumero(validacao.limpo);

        const location = new (require('whatsapp-web.js').Location)(lat, lng, {
            name: nome || 'Localização',
            address: endereco || ''
        });

        const msgEnviada = await enviarComRetry(async () => {
            const chat = await client.getChatById(numeroFormatado);
            return await chat.sendMessage(location);
        });

        totalMensagensEnviadas++;

        res.json({
            success: true,
            mensagem: 'Localização enviada com sucesso',
            dados: { id: msgEnviada.id._serialized, numero: numeroFormatado }
        });
    } catch (error) {
        const analise = analisarErroWhatsapp(error, req.body.numero);
        totalErros++;
        console.error('[ERRO] Localização:', error.message);
        res.status(500).json({ success: false, error: analise.mensagem, tipo: analise.tipo, acao: analise.acao });
    }
});

// Enviar contato
app.post('/api/enviar-contato', requireReady, async (req, res) => {
    try {
        const { numero, contato_numero, contato_nome } = req.body;

        if (!numero || !contato_numero || !contato_nome) {
            return res.status(400).json({ success: false, error: 'Campos obrigatórios: "numero", "contato_numero", "contato_nome"' });
        }

        const validacao = validarNumero(numero);
        if (!validacao.valido) {
            return res.status(400).json({ success: false, error: validacao.erro });
        }

        const numeroFormatado = formatarNumero(validacao.limpo);

        const msgEnviada = await enviarComRetry(async () => {
            const chat = await client.getChatById(numeroFormatado);
            const contact = new (require('whatsapp-web.js').Contact)();
            contact.id = { _serialized: formatarNumero(contato_numero) };
            contact.number = contato_numero;
            contact.name = contato_nome;
            return await chat.sendMessage(contact);
        });

        totalMensagensEnviadas++;

        res.json({
            success: true,
            mensagem: 'Contato enviado com sucesso',
            dados: { id: msgEnviada.id._serialized, numero: numeroFormatado }
        });
    } catch (error) {
        const analise = analisarErroWhatsapp(error, req.body.numero);
        totalErros++;
        res.status(500).json({ success: false, error: analise.mensagem, tipo: analise.tipo, acao: analise.acao });
    }
});

// Enviar enquete
app.post('/api/enviar-enquete', requireReady, async (req, res) => {
    try {
        const { numero, titulo, opcoes, multipla } = req.body;

        if (!numero || !titulo || !opcoes || !Array.isArray(opcoes) || opcoes.length < 2) {
            return res.status(400).json({ success: false, error: 'Campos obrigatórios: "numero", "titulo", "opcoes" (array com no mínimo 2 opções)' });
        }

        if (opcoes.length > 12) {
            return res.status(400).json({ success: false, error: 'Máximo de 12 opções por enquete' });
        }

        const validacao = validarNumero(numero);
        if (!validacao.valido) {
            return res.status(400).json({ success: false, error: validacao.erro });
        }

        const numeroFormatado = formatarNumero(validacao.limpo);

        const msgEnviada = await enviarComRetry(async () => {
            const chat = await client.getChatById(numeroFormatado);
            const poll = new (require('whatsapp-web.js').Poll)(titulo, opcoes, {
                allowMultipleAnswers: !!multipla
            });
            return await chat.sendMessage(poll);
        });

        totalMensagensEnviadas++;

        res.json({
            success: true,
            mensagem: 'Enquete enviada com sucesso',
            dados: { id: msgEnviada.id._serialized, numero: numeroFormatado }
        });
    } catch (error) {
        const analise = analisarErroWhatsapp(error, req.body.numero);
        totalErros++;
        res.status(500).json({ success: false, error: analise.mensagem, tipo: analise.tipo, acao: analise.acao });
    }
});

// Enviar lista interativa
app.post('/api/enviar-lista', requireReady, async (req, res) => {
    try {
        const { numero, titulo, texto, botao, secoes } = req.body;

        if (!numero || !titulo || !botao || !secoes) {
            return res.status(400).json({ success: false, error: 'Campos obrigatórios: "numero", "titulo", "botao", "secoes"' });
        }

        const validacao = validarNumero(numero);
        if (!validacao.valido) {
            return res.status(400).json({ success: false, error: validacao.erro });
        }

        const numeroFormatado = formatarNumero(validacao.limpo);

        const msgEnviada = await enviarComRetry(async () => {
            const chat = await client.getChatById(numeroFormatado);
            const list = new (require('whatsapp-web.js').List)(texto || titulo, botao, secoes, titulo);
            return await chat.sendMessage(list);
        });

        totalMensagensEnviadas++;

        res.json({
            success: true,
            mensagem: 'Lista interativa enviada com sucesso',
            dados: { id: msgEnviada.id._serialized, numero: numeroFormatado }
        });
    } catch (error) {
        const analise = analisarErroWhatsapp(error, req.body.numero);
        totalErros++;
        res.status(500).json({ success: false, error: analise.mensagem, tipo: analise.tipo, acao: analise.acao });
    }
});

// Enviar botões (reply buttons)
app.post('/api/enviar-botoes', requireReady, async (req, res) => {
    try {
        const { numero, texto, botoes, titulo, rodape } = req.body;

        if (!numero || !texto || !botoes || !Array.isArray(botoes)) {
            return res.status(400).json({ success: false, error: 'Campos obrigatórios: "numero", "texto", "botoes" (array)' });
        }

        if (botoes.length === 0 || botoes.length > 3) {
            return res.status(400).json({ success: false, error: 'Mínimo 1, máximo 3 botões' });
        }

        const validacao = validarNumero(numero);
        if (!validacao.valido) {
            return res.status(400).json({ success: false, error: validacao.erro });
        }

        const numeroFormatado = formatarNumero(validacao.limpo);

        const buttonsList = botoes.map(b => {
            if (typeof b === 'string') return { body: b };
            return b;
        });

        const msgEnviada = await enviarComRetry(async () => {
            const chat = await client.getChatById(numeroFormatado);
            const buttons = new (require('whatsapp-web.js').Buttons)(texto, buttonsList, titulo || null, rodape || null);
            return await chat.sendMessage(buttons);
        });

        totalMensagensEnviadas++;

        res.json({
            success: true,
            mensagem: 'Botões enviados com sucesso',
            dados: { id: msgEnviada.id._serialized, numero: numeroFormatado }
        });
    } catch (error) {
        const analise = analisarErroWhatsapp(error, req.body.numero);
        totalErros++;
        res.status(500).json({ success: false, error: analise.mensagem, tipo: analise.tipo, acao: analise.acao });
    }
});

// Verificar se um número existe no WhatsApp
app.get('/api/verificar-numero/:numero', requireReady, async (req, res) => {
    try {
        const validacao = validarNumero(req.params.numero);
        if (!validacao.valido) {
            return res.status(400).json({ success: false, error: validacao.erro });
        }

        const numeroFormatado = formatarNumero(validacao.limpo);

        const numeroId = await comTimeout(
            client.getNumberId(numeroFormatado),
            15000,
            'verificação de número'
        );

        res.json({
            success: true,
            numero: req.params.numero,
            registrado_no_whatsapp: !!numeroId,
            dados: numeroId || null
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Erro ao verificar número',
            detalhes: error.message
        });
    }
});

// Listar contatos salvos
app.get('/api/contatos', requireReady, async (req, res) => {
    try {
        const now = Date.now();
        if (contactsCache.length > 0 && (now - contactsCacheTime) < CONTACTS_CACHE_TTL) {
            return res.json({ success: true, contatos: contactsCache, cache: true });
        }

        const contacts = await comTimeout(client.getContacts(), 30000, 'listar contatos');

        contactsCache = contacts
            .filter(c => c.isMyContact && c.id && c.id.user)
            .map(c => ({
                numero: c.number || c.id.user,
                nome: c.name || c.pushname || '',
                nome_agenda: c.name || '',
                isMe: c.isMe || false,
                bloqueado: isBlocked(c.number || c.id.user)
            }))
            .sort((a, b) => a.nome.localeCompare(b.nome, 'pt', { sensitivity: 'base' }));

        contactsCacheTime = now;

        res.json({ success: true, contatos: contactsCache, total: contactsCache.length });
    } catch (error) {
        console.error('[API] Erro ao listar contatos:', error.message);

        if (contactsCache.length > 0) {
            return res.json({
                success: true,
                contatos: contactsCache,
                total: contactsCache.length,
                cache: true,
                aviso: 'Usando cache. Contatos podem estar desatualizados.'
            });
        }

        res.status(500).json({ success: false, error: 'Erro ao listar contatos', detalhes: error.message });
    }
});

// Listar contatos bloqueados
app.get('/api/bloqueados', (req, res) => {
    const lista = [...blockedContacts].map(num => {
        const contato = contactsCache.find(c => c.numero === num);
        return { numero: num, nome: contato ? contato.nome : '' };
    });
    res.json({ success: true, bloqueados: lista, total: lista.length });
});

// Bloquear contato
app.post('/api/bloquear/:numero', (req, res) => {
    const limpo = String(req.params.numero).replace(/\D/g, '');

    if (limpo.length < 10) {
        return res.status(400).json({ success: false, error: 'Número inválido' });
    }

    if (blockedContacts.has(limpo)) {
        return res.json({ success: true, mensagem: 'Contato já estava bloqueado', numero: limpo });
    }

    blockedContacts.add(limpo);
    saveBlocklist();

    // Atualiza cache
    const cacheEntry = contactsCache.find(c => c.numero === limpo);
    if (cacheEntry) cacheEntry.bloqueado = true;

    // Limpa conversa ativa se existir
    const chatId = limpo + '@c.us';
    if (conversations.has(chatId)) {
        conversations.delete(chatId);
    }

    console.log(`[BLOCKLIST] Contato bloqueado: ${limpo}`);
    res.json({ success: true, mensagem: 'Contato bloqueado com sucesso', numero: limpo });
});

// Desbloquear contato
app.post('/api/desbloquear/:numero', (req, res) => {
    const limpo = String(req.params.numero).replace(/\D/g, '');

    if (!blockedContacts.has(limpo)) {
        return res.json({ success: true, mensagem: 'Contato não estava bloqueado', numero: limpo });
    }

    blockedContacts.delete(limpo);
    saveBlocklist();

    // Atualiza cache
    const cacheEntry = contactsCache.find(c => c.numero === limpo);
    if (cacheEntry) cacheEntry.bloqueado = false;

    console.log(`[BLOCKLIST] Contato desbloqueado: ${limpo}`);
    res.json({ success: true, mensagem: 'Contato desbloqueado com sucesso', numero: limpo });
});

// Recarregar cache de contatos (força refresh)
app.post('/api/contatos/refresh', requireReady, async (req, res) => {
    try {
        contactsCacheTime = 0;
        const contacts = await comTimeout(client.getContacts(), 30000, 'refresh contatos');

        contactsCache = contacts
            .filter(c => c.isMyContact && c.id && c.id.user)
            .map(c => ({
                numero: c.number || c.id.user,
                nome: c.name || c.pushname || '',
                nome_agenda: c.name || '',
                isMe: c.isMe || false,
                bloqueado: isBlocked(c.number || c.id.user)
            }))
            .sort((a, b) => a.nome.localeCompare(b.nome, 'pt', { sensitivity: 'base' }));

        contactsCacheTime = Date.now();

        res.json({ success: true, contatos: contactsCache, total: contactsCache.length });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro ao recarregar contatos', detalhes: error.message });
    }
});

// Desconectar
app.post('/api/logout', async (req, res) => {
    try {
        await client.logout();
        clientReady = false;
        reconnectTentativas = CONFIG.MAX_RECONNECT_TENTATIVAS;
        statusMessage = 'Logout realizado com sucesso. Sessão encerrada.';
        res.json({ success: true, mensagem: 'Desconectado com sucesso' });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro ao desconectar', detalhes: error.message });
    }
});

// Reiniciar cliente
app.post('/api/reiniciar', async (req, res) => {
    try {
        await client.destroy().catch(() => {});
        clientReady = false;
        lastQr = null;
        reconnectTentativas = 0;
        statusMessage = 'Reiniciando...';

        client = criarCliente();
        setupClientEvents();
        await client.initialize();

        res.json({ success: true, mensagem: 'Cliente reiniciado. Aguarde o QR Code.' });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro ao reiniciar', detalhes: error.message });
    }
});

// ── Helpers ──
function formatarNumero(numero) {
    let numStr = String(numero).replace(/\D/g, '');
    if (!numStr.endsWith('@c.us')) {
        numStr = numStr + '@c.us';
    }
    return numStr;
}

function mimePorTipo(tipo) {
    const map = {
        imagem: 'image/jpeg',
        image: 'image/jpeg',
        audio: 'audio/mp3',
        video: 'video/mp4',
        documento: 'application/pdf',
        document: 'application/pdf',
        sticker: 'image/webp'
    };
    return map[tipo] || 'application/octet-stream';
}

function nomePadrao(tipo) {
    const map = {
        imagem: 'imagem.jpg',
        image: 'imagem.jpg',
        audio: 'audio.mp3',
        video: 'video.mp4',
        documento: 'documento.pdf',
        document: 'documento.pdf',
        sticker: 'sticker.webp'
    };
    return map[tipo] || 'arquivo';
}

// ── Graceful shutdown ──
let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n[SHUTDOWN] Sinal ${signal} recebido. Encerrando graciosamente...`);

    statusMessage = 'Encerrando servidor...';
    clientReady = false;

    try {
        await Promise.race([
            client.destroy(),
            new Promise(resolve => setTimeout(resolve, 10000))
        ]);
        console.log('[SHUTDOWN] Cliente WhatsApp destruído');
    } catch (err) {
        console.error('[SHUTDOWN] Erro ao destruir cliente:', err.message);
    }

    console.log('[SHUTDOWN] Servidor encerrado');
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Inicialização do servidor ──
const PORTA = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const server = app.listen(PORTA, HOST, () => {
    console.log(`[API] Servidor rodando em http://${HOST}:${PORTA}`);
    console.log('[API] Endpoints disponíveis:');
    console.log('  GET  /api/status                  - Status completo com estatísticas');
    console.log('  GET  /api/qr                      - Obter QR Code');
    console.log('  GET  /api/verificar-numero/:numero - Verificar número');
    console.log('  POST /api/enviar-mensagem         - Enviar texto');
    console.log('  POST /api/enviar-mensagem-bulk    - Enviar texto em lote');
    console.log('  POST /api/enviar-midia            - Enviar mídia genérica');
    console.log('  POST /api/enviar-imagem           - Enviar imagem');
    console.log('  POST /api/enviar-audio            - Enviar áudio');
    console.log('  POST /api/enviar-video            - Enviar vídeo');
    console.log('  POST /api/enviar-documento        - Enviar documento');
    console.log('  POST /api/enviar-sticker          - Enviar sticker');
    console.log('  POST /api/enviar-midia-bulk       - Enviar mídia em lote');
    console.log('  POST /api/enviar-localizacao      - Enviar localização');
    console.log('  POST /api/enviar-contato          - Enviar contato');
    console.log('  POST /api/enviar-enquete          - Enviar enquete');
    console.log('  POST /api/enviar-lista            - Enviar lista interativa');
    console.log('  POST /api/enviar-botoes           - Enviar botões de resposta');
    console.log('  POST /api/logout                  - Desconectar');
    console.log('  POST /api/reiniciar               - Reiniciar cliente');
    console.log('  GET  /api/contatos                - Listar contatos salvos');
    console.log('  POST /api/contatos/refresh        - Atualizar cache de contatos');
    console.log('  GET  /api/bloqueados              - Listar contatos bloqueados');
    console.log('  POST /api/bloquear/:numero        - Bloquear contato');
    console.log('  POST /api/desbloquear/:numero     - Desbloquear contato');
    console.log('  GET  /                            - Painel de gerenciamento');
    console.log('');
    console.log('[CONFIG] Timeout operações:', CONFIG.OPERATION_TIMEOUT_MS / 1000, 's');
    console.log('[CONFIG] Delay entre bulk:', CONFIG.BULK_DELAY_MS, 'ms');
    console.log('[CONFIG] Máx tentativas reconexão:', CONFIG.MAX_RECONNECT_TENTATIVAS);
    console.log('[CONFIG] Retry por operação:', CONFIG.RETRY_TENTATIVAS);
});
