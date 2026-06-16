require('dotenv').config();

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode-terminal');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

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
    console.log('  GET  /api/status           - Status da conexão');
    console.log('  GET  /api/qr               - Obter QR Code');
    console.log('  GET  /api/verificar-numero/:numero - Verificar número');
    console.log('  POST /api/enviar-mensagem   - Enviar mensagem');
    console.log('  POST /api/enviar-mensagem-bulk - Enviar em lote');
    console.log('  POST /api/logout            - Desconectar');
    console.log('  POST /api/reiniciar         - Reiniciar cliente');
});
