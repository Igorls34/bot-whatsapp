require('dotenv').config();

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode-terminal');
const cors = require('cors');

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
    console.log('  POST /api/logout                  - Desconectar');
    console.log('  POST /api/reiniciar               - Reiniciar cliente');
    console.log('');
    console.log('[CONFIG] Timeout operações:', CONFIG.OPERATION_TIMEOUT_MS / 1000, 's');
    console.log('[CONFIG] Delay entre bulk:', CONFIG.BULK_DELAY_MS, 'ms');
    console.log('[CONFIG] Máx tentativas reconexão:', CONFIG.MAX_RECONNECT_TENTATIVAS);
    console.log('[CONFIG] Retry por operação:', CONFIG.RETRY_TENTATIVAS);
});
