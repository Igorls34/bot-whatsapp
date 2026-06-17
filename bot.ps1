param(
    [Parameter(Position=0)][string]$Comando,
    [Parameter(Position=1)][string]$Numero,
    [string]$Mensagem,
    [string]$Url,
    [string]$Legenda,
    [string[]]$Numeros,
    [string]$Titulo,
    [string[]]$Opcoes,
    [string]$Arquivo,
    [string]$Botoes,
    [string]$Rodape,
    [string]$Botao,
    $Secoes,
    [string]$Latitude,
    [string]$Longitude
)

$API = "http://2.24.124.93:3000"

function Send-Post($endpoint, $body) {
    try {
        $json = $body | ConvertTo-Json -Compress
        $result = Invoke-RestMethod -Method Post -Uri "$API$endpoint" -Body $json -ContentType "application/json" -ErrorAction Stop
        if ($result.success) {
            Write-Host "OK - $($result.mensagem)" -ForegroundColor Green
        } else {
            Write-Host "ERRO - $($result.error)" -ForegroundColor Red
            if ($result.acao) { Write-Host "     > $($result.acao)" -ForegroundColor Yellow }
        }
        return $result
    } catch {
        Write-Host "FALHA: $_" -ForegroundColor Red
    }
}

switch ($Comando.ToLower()) {
    "status" {
        Invoke-RestMethod "$API/api/status" | ConvertTo-Json
    }
    
    "qr" {
        $qr = Invoke-RestMethod "$API/api/qr"
        if ($qr.success) {
            Write-Host "QR Code: $($qr.qr)" -ForegroundColor Cyan
            Write-Host "Copie o código e gere a imagem em: https://api.qrserver.com/v1/create-qr-code/?data=$($qr.qr)" -ForegroundColor Yellow
        } else {
            Write-Host $qr.mensagem -ForegroundColor Yellow
        }
    }
    
    "texto" {
        if (!$Numero) { Write-Host "Uso: .\bot.ps1 texto 5511999998888 -Mensagem 'Olá!'" -ForegroundColor Yellow; return }
        Send-Post "/api/enviar-mensagem" @{numero=$Numero; mensagem=$Mensagem}
    }
    
    "lote" {
        if (!$Numeros -or !$Mensagem) { Write-Host "Uso: .\bot.ps1 lote -Numeros 55119...,55119... -Mensagem 'texto'" -ForegroundColor Yellow; return }
        Send-Post "/api/enviar-mensagem-bulk" @{numeros=$Numeros; mensagem=$Mensagem}
    }
    
    "imagem" {
        if (!$Numero) { Write-Host "Uso: .\bot.ps1 imagem 55119... -Url 'https://...' [-Legenda 'texto']" -ForegroundColor Yellow; return }
        Send-Post "/api/enviar-imagem" @{numero=$Numero; url=$Url; legenda=$Legenda}
    }
    
    "audio" {
        if (!$Numero -or !$Url) { Write-Host "Uso: .\bot.ps1 audio 55119... -Url 'https://...'" -ForegroundColor Yellow; return }
        Send-Post "/api/enviar-audio" @{numero=$Numero; url=$Url}
    }
    
    "video" {
        if (!$Numero -or !$Url) { Write-Host "Uso: .\bot.ps1 video 55119... -Url 'https://...' [-Legenda 'texto']" -ForegroundColor Yellow; return }
        Send-Post "/api/enviar-video" @{numero=$Numero; url=$Url; legenda=$Legenda}
    }
    
    "documento" {
        if (!$Numero -or !$Url) { Write-Host "Uso: .\bot.ps1 documento 55119... -Url 'https://...' [-Legenda 'texto']" -ForegroundColor Yellow; return }
        Send-Post "/api/enviar-documento" @{numero=$Numero; url=$Url; legenda=$Legenda}
    }
    
    "local" {
        if (!$Numero) { Write-Host "Uso: .\bot.ps1 local 55119... -Latitude -23.55 -Longitude -46.63" -ForegroundColor Yellow; return }
        Send-Post "/api/enviar-localizacao" @{numero=$Numero; latitude=$Latitude; longitude=$Longitude; nome=$Legenda}
    }
    
        "botoes" {
        if (!$Numero -or !$Mensagem) { Write-Host "Uso: .\bot.ps1 botoes 55119... -Mensagem 'texto' -Botoes 'Sim','Nao'" -ForegroundColor Yellow; return }
        $btnArray = if ($Botoes) { $Botoes.Split(',') | ForEach-Object { $_.Trim() } } else { @("Sim", "Nao") }
        Send-Post "/api/enviar-botoes" @{numero=$Numero; texto=$Mensagem; botoes=$btnArray; titulo=$Titulo; rodape=$Rodape}
    }
    
    "lista" {
        if (!$Numero) { Write-Host "Uso: .\bot.ps1 lista 55119... -Titulo 'Menu' -Mensagem 'Escolha:' -Botao 'Ver'" -ForegroundColor Yellow; return }
        Send-Post "/api/enviar-lista" @{numero=$Numero; titulo=$Titulo; texto=$Mensagem; botao=$Botao; secoes=$Secoes}
    }
        if (!$Numero -or !$Titulo -or !$Opcoes) { Write-Host "Uso: .\bot.ps1 enquete 55119... -Titulo 'Pergunta?' -Opcoes 'A','B','C'" -ForegroundColor Yellow; return }
        Send-Post "/api/enviar-enquete" @{numero=$Numero; titulo=$Titulo; opcoes=$Opcoes}
    }
    
    "verificar" {
        if (!$Numero) { Write-Host "Uso: .\bot.ps1 verificar 5511999998888" -ForegroundColor Yellow; return }
        $r = Invoke-RestMethod "$API/api/verificar-numero/$Numero"
        if ($r.registrado_no_whatsapp) { Write-Host "SIM - $Numero tem WhatsApp" -ForegroundColor Green }
        else { Write-Host "NAO - $Numero nao tem WhatsApp" -ForegroundColor Red }
    }
    
    "reiniciar" {
        Send-Post "/api/reiniciar" @{}
    }
    
    "logout" {
        Send-Post "/api/logout" @{}
    }
    
    default {
        Write-Host @"
BOT WHATSAPP CLI

  .\bot.ps1 status                                    Status do bot
  .\bot.ps1 qr                                        Ver QR Code
  .\bot.ps1 texto <numero> -Mensagem 'texto'          Enviar texto
  .\bot.ps1 lote -Numeros 55...,55... -Mensagem '..'  Enviar em lote
  .\bot.ps1 imagem <numero> -Url 'https://...'        Enviar imagem
  .\bot.ps1 audio <numero> -Url 'https://...'         Enviar audio
  .\bot.ps1 video <numero> -Url 'https://...'         Enviar video
  .\bot.ps1 documento <numero> -Url 'https://...'     Enviar documento
  .\bot.ps1 enquete <numero> -Titulo '?' -Opcoes A,B  Enviar enquete
  .\bot.ps1 botoes <numero> -Mensagem '...' -Botoes 'Sim,Nao'  Enviar botoes
  .\bot.ps1 lista <numero> -Titulo 'Menu' -Botao 'Ver'   Enviar lista interativa
  .\bot.ps1 verificar <numero>                        Verificar numero
  .\bot.ps1 reiniciar                                 Reiniciar bot
  .\bot.ps1 logout                                    Desconectar
"@
    }
}
