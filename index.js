require('dotenv').config();

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode-terminal');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ── Estado da aplicação ──
let clientReady = false;
let clientInitialized = false;
let lastQr = null;
let statusMessage = 'Inicializando...';

// ── Cliente WhatsApp ──
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './session' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--disable-gpu'
        ]
    }
});

// ── Eventos do WhatsApp ──
client.on('qr', (qr) => {
    lastQr = qr;
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
    console.error('[AUTH] Falha na autenticação:', msg);
});

client.on('ready', () => {
    clientReady = true;
    clientInitialized = true;
    statusMessage = 'Cliente WhatsApp pronto e conectado';
    console.log('[READY] Cliente WhatsApp pronto');
});

client.on('disconnected', (reason) => {
    clientReady = false;
    statusMessage = `Desconectado: ${reason}`;
    console.log('[DISCONNECT]', reason);
});

// Inicia o cliente
console.log('[INIT] Iniciando cliente WhatsApp...');
client.initialize().catch(err => {
    statusMessage = `Erro ao inicializar: ${err.message}`;
    console.error('[INIT] Erro ao inicializar:', err.message);
});

// ── Middleware de verificação ──
function requireReady(req, res, next) {
    if (!clientReady) {
        return res.status(503).json({
            success: false,
            error: 'Cliente WhatsApp não está pronto',
            status: statusMessage,
            dica: 'Escaneie o QR Code ou aguarde a conexão'
        });
    }
    next();
}

// ── Rotas da API ──

// Status da conexão
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        pronto: clientReady,
        inicializado: clientInitialized,
        status: statusMessage,
        timestamp: new Date().toISOString()
    });
});

// Obter QR Code (em texto para terminal)
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

        // Formata o número (remove caracteres não numéricos, adiciona @c.us)
        const numeroFormatado = formatarNumero(numero);

        const chat = await client.getChatById(numeroFormatado);
        const msgEnviada = await chat.sendMessage(mensagem);

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
        console.error('[ERRO] Envio de mensagem:', error.message);
        res.status(500).json({
            success: false,
            error: 'Erro ao enviar mensagem',
            detalhes: error.message,
            dica: 'Verifique se o número está correto e registrado no WhatsApp'
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

        const resultados = [];
        for (const numero of numeros) {
            try {
                const numeroFormatado = formatarNumero(numero);
                const chat = await client.getChatById(numeroFormatado);
                const msgEnviada = await chat.sendMessage(mensagem);
                resultados.push({
                    numero: numeroFormatado,
                    status: 'enviado',
                    id: msgEnviada.id._serialized
                });
            } catch (err) {
                resultados.push({
                    numero: numero,
                    status: 'erro',
                    erro: err.message
                });
            }
        }

        const enviados = resultados.filter(r => r.status === 'enviado').length;

        res.json({
            success: true,
            mensagem: `${enviados} de ${numeros.length} mensagens enviadas`,
            resultados
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Erro ao enviar mensagens em lote',
            detalhes: error.message
        });
    }
});

// ── Envio de mídia (genérico) ──
// Tipos suportados: imagem, audio, video, documento, sticker
// Aceita URL (url) OU arquivo base64 (base64 + mimetype + filename)
app.post('/api/enviar-midia', requireReady, async (req, res) => {
    try {
        const { numero, tipo, url, base64, mimetype, filename, legenda } = req.body;

        if (!numero) {
            return res.status(400).json({ success: false, error: 'Campo "numero" é obrigatório' });
        }
        if (!tipo) {
            return res.status(400).json({ success: false, error: 'Campo "tipo" é obrigatório (imagem, audio, video, documento, sticker)' });
        }

        const numeroFormatado = formatarNumero(numero);
        let media;

        if (base64) {
            const mime = mimetype || 'application/octet-stream';
            media = new MessageMedia(mime, base64, filename || 'arquivo');
        } else if (url) {
            media = await MessageMedia.fromUrl(url, { unsafeMime: true });
        } else {
            return res.status(400).json({ success: false, error: 'Forneça "url" ou "base64"' });
        }

        const chat = await client.getChatById(numeroFormatado);

        let msgEnviada;
        const opts = legenda ? { caption: legenda } : {};

        switch (tipo.toLowerCase()) {
            case 'imagem':
            case 'image':
                msgEnviada = await chat.sendMessage(media, { ...opts, sendMediaAsSticker: false });
                break;
            case 'audio':
            case 'audio':
                msgEnviada = await chat.sendMessage(media, { sendAudioAsVoice: true });
                break;
            case 'video':
                msgEnviada = await chat.sendMessage(media, { ...opts, sendMediaAsSticker: false });
                break;
            case 'documento':
            case 'document':
                msgEnviada = await chat.sendMessage(media, { ...opts, sendMediaAsDocument: true });
                break;
            case 'sticker':
                msgEnviada = await chat.sendMessage(media, { sendMediaAsSticker: true });
                break;
            default:
                return res.status(400).json({ success: false, error: `Tipo "${tipo}" não suportado. Use: imagem, audio, video, documento, sticker` });
        }

        res.json({
            success: true,
            mensagem: `${tipo} enviado com sucesso`,
            dados: { id: msgEnviada.id._serialized, numero: numeroFormatado, tipo }
        });

    } catch (error) {
        console.error('[ERRO] Envio de mídia:', error.message);
        res.status(500).json({ success: false, error: 'Erro ao enviar mídia', detalhes: error.message });
    }
});

// Enviar imagem
app.post('/api/enviar-imagem', requireReady, async (req, res) => {
    req.body.tipo = 'imagem';
    await handleMidia(req, res);
});

// Enviar áudio
app.post('/api/enviar-audio', requireReady, async (req, res) => {
    req.body.tipo = 'audio';
    await handleMidia(req, res);
});

// Enviar vídeo
app.post('/api/enviar-video', requireReady, async (req, res) => {
    req.body.tipo = 'video';
    await handleMidia(req, res);
});

// Enviar documento
app.post('/api/enviar-documento', requireReady, async (req, res) => {
    req.body.tipo = 'documento';
    await handleMidia(req, res);
});

// Enviar sticker
app.post('/api/enviar-sticker', requireReady, async (req, res) => {
    req.body.tipo = 'sticker';
    await handleMidia(req, res);
});

async function handleMidia(req, res) {
    try {
        const { numero, url, base64, mimetype, filename, legenda, tipo } = req.body;

        if (!numero) {
            return res.status(400).json({ success: false, error: 'Campo "numero" é obrigatório' });
        }

        const numeroFormatado = formatarNumero(numero);
        let media;

        if (base64) {
            const mime = mimetype || mimePorTipo(tipo);
            media = new MessageMedia(mime, base64, filename || nomePadrao(tipo));
        } else if (url) {
            media = await MessageMedia.fromUrl(url, { unsafeMime: true });
        } else {
            return res.status(400).json({ success: false, error: 'Forneça "url" ou "base64"' });
        }

        const chat = await client.getChatById(numeroFormatado);
        let msgEnviada;

        switch (tipo) {
            case 'imagem':
                msgEnviada = await chat.sendMessage(media, { caption: legenda || '' });
                break;
            case 'audio':
                msgEnviada = await chat.sendMessage(media, { sendAudioAsVoice: true });
                break;
            case 'video':
                msgEnviada = await chat.sendMessage(media, { caption: legenda || '' });
                break;
            case 'documento':
                msgEnviada = await chat.sendMessage(media, { sendMediaAsDocument: true, caption: legenda || '' });
                break;
            case 'sticker':
                msgEnviada = await chat.sendMessage(media, { sendMediaAsSticker: true });
                break;
        }

        res.json({
            success: true,
            mensagem: `${tipo} enviado com sucesso`,
            dados: { id: msgEnviada.id._serialized, numero: numeroFormatado, tipo }
        });

    } catch (error) {
        console.error(`[ERRO] Envio de ${req.body.tipo}:`, error.message);
        res.status(500).json({ success: false, error: `Erro ao enviar ${req.body.tipo}`, detalhes: error.message });
    }
}

// Enviar localização
app.post('/api/enviar-localizacao', requireReady, async (req, res) => {
    try {
        const { numero, latitude, longitude, nome, endereco } = req.body;

        if (!numero || latitude == null || longitude == null) {
            return res.status(400).json({ success: false, error: 'Campos obrigatórios: "numero", "latitude", "longitude"' });
        }

        const numeroFormatado = formatarNumero(numero);
        const chat = await client.getChatById(numeroFormatado);

        const location = new (require('whatsapp-web.js').Location)(
            parseFloat(latitude),
            parseFloat(longitude),
            { name: nome || 'Localização', address: endereco || '' }
        );

        const msgEnviada = await chat.sendMessage(location);

        res.json({
            success: true,
            mensagem: 'Localização enviada com sucesso',
            dados: { id: msgEnviada.id._serialized, numero: numeroFormatado }
        });
    } catch (error) {
        console.error('[ERRO] Envio de localização:', error.message);
        res.status(500).json({ success: false, error: 'Erro ao enviar localização', detalhes: error.message });
    }
});

// Enviar contato
app.post('/api/enviar-contato', requireReady, async (req, res) => {
    try {
        const { numero, contato_numero, contato_nome } = req.body;

        if (!numero || !contato_numero || !contato_nome) {
            return res.status(400).json({ success: false, error: 'Campos obrigatórios: "numero", "contato_numero", "contato_nome"' });
        }

        const numeroFormatado = formatarNumero(numero);
        const chat = await client.getChatById(numeroFormatado);

        const contact = new (require('whatsapp-web.js').Contact)();
        contact.id = { _serialized: formatarNumero(contato_numero) };
        contact.number = contato_numero;
        contact.name = contato_nome;

        const msgEnviada = await chat.sendMessage(contact);

        res.json({
            success: true,
            mensagem: 'Contato enviado com sucesso',
            dados: { id: msgEnviada.id._serialized, numero: numeroFormatado }
        });
    } catch (error) {
        console.error('[ERRO] Envio de contato:', error.message);
        res.status(500).json({ success: false, error: 'Erro ao enviar contato', detalhes: error.message });
    }
});

// Enviar enquete
app.post('/api/enviar-enquete', requireReady, async (req, res) => {
    try {
        const { numero, titulo, opcoes, multipla } = req.body;

        if (!numero || !titulo || !opcoes || !Array.isArray(opcoes) || opcoes.length < 2) {
            return res.status(400).json({ success: false, error: 'Campos obrigatórios: "numero", "titulo", "opcoes" (array com no mínimo 2 opções)' });
        }

        const numeroFormatado = formatarNumero(numero);
        const chat = await client.getChatById(numeroFormatado);

        const poll = new (require('whatsapp-web.js').Poll)(titulo, opcoes, {
            allowMultipleAnswers: !!multipla
        });

        const msgEnviada = await chat.sendMessage(poll);

        res.json({
            success: true,
            mensagem: 'Enquete enviada com sucesso',
            dados: { id: msgEnviada.id._serialized, numero: numeroFormatado }
        });
    } catch (error) {
        console.error('[ERRO] Envio de enquete:', error.message);
        res.status(500).json({ success: false, error: 'Erro ao enviar enquete', detalhes: error.message });
    }
});

// Enviar mensagem com botões (lista interativa)
app.post('/api/enviar-lista', requireReady, async (req, res) => {
    try {
        const { numero, titulo, texto, botao, secoes } = req.body;

        if (!numero || !titulo || !botao || !secoes) {
            return res.status(400).json({ success: false, error: 'Campos obrigatórios: "numero", "titulo", "botao", "secoes"' });
        }

        const numeroFormatado = formatarNumero(numero);
        const chat = await client.getChatById(numeroFormatado);

        const list = new (require('whatsapp-web.js').List)(
            texto || titulo,
            botao,
            secoes,
            titulo
        );

        const msgEnviada = await chat.sendMessage(list);

        res.json({
            success: true,
            mensagem: 'Lista interativa enviada com sucesso',
            dados: { id: msgEnviada.id._serialized, numero: numeroFormatado }
        });
    } catch (error) {
        console.error('[ERRO] Envio de lista:', error.message);
        res.status(500).json({ success: false, error: 'Erro ao enviar lista', detalhes: error.message });
    }
});

// ── Helpers de mídia ──
function mimePorTipo(tipo) {
    const map = {
        imagem: 'image/jpeg',
        audio: 'audio/mp3',
        video: 'video/mp4',
        documento: 'application/pdf',
        sticker: 'image/webp'
    };
    return map[tipo] || 'application/octet-stream';
}

function nomePadrao(tipo) {
    const map = {
        imagem: 'imagem.jpg',
        audio: 'audio.mp3',
        video: 'video.mp4',
        documento: 'documento.pdf',
        sticker: 'sticker.webp'
    };
    return map[tipo] || 'arquivo';
}

// Verificar se um número existe no WhatsApp
app.get('/api/verificar-numero/:numero', requireReady, async (req, res) => {
    try {
        const numeroFormatado = formatarNumero(req.params.numero);
        const numeroId = await client.getNumberId(numeroFormatado);

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

// Desconectar / logout
app.post('/api/logout', async (req, res) => {
    try {
        if (clientReady) {
            await client.logout();
            clientReady = false;
        }
        res.json({ success: true, mensagem: 'Desconectado com sucesso' });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Erro ao desconectar',
            detalhes: error.message
        });
    }
});

// Reiniciar cliente
app.post('/api/reiniciar', async (req, res) => {
    try {
        await client.destroy();
        clientReady = false;
        lastQr = null;
        statusMessage = 'Reiniciando...';
        await client.initialize();
        res.json({ success: true, mensagem: 'Cliente reiniciado. Aguarde o QR Code.' });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Erro ao reiniciar',
            detalhes: error.message
        });
    }
});

// ── Funções auxiliares ──
function formatarNumero(numero) {
    let numStr = String(numero).replace(/\D/g, '');
    if (!numStr.endsWith('@c.us')) {
        numStr = numStr + '@c.us';
    }
    return numStr;
}

// ── Inicialização do servidor ──
const PORTA = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORTA, HOST, () => {
    console.log(`[API] Servidor rodando em http://${HOST}:${PORTA}`);
    console.log('[API] Endpoints disponíveis:');
    console.log('  GET  /api/status                  - Status da conexão');
    console.log('  GET  /api/qr                      - Obter QR Code');
    console.log('  GET  /api/verificar-numero/:numero - Verificar número');
    console.log('  POST /api/enviar-mensagem         - Enviar mensagem de texto');
    console.log('  POST /api/enviar-mensagem-bulk    - Enviar texto em lote');
    console.log('  POST /api/enviar-midia            - Enviar mídia genérica');
    console.log('  POST /api/enviar-imagem           - Enviar imagem');
    console.log('  POST /api/enviar-audio            - Enviar áudio');
    console.log('  POST /api/enviar-video            - Enviar vídeo');
    console.log('  POST /api/enviar-documento        - Enviar documento');
    console.log('  POST /api/enviar-sticker          - Enviar sticker');
    console.log('  POST /api/enviar-localizacao      - Enviar localização');
    console.log('  POST /api/enviar-contato          - Enviar contato');
    console.log('  POST /api/enviar-enquete          - Enviar enquete');
    console.log('  POST /api/enviar-lista            - Enviar lista interativa');
    console.log('  POST /api/logout                  - Desconectar');
    console.log('  POST /api/reiniciar               - Reiniciar cliente');
});
