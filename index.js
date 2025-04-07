require('dotenv').config();
const axios = require('axios');
const ethers = require('ethers');
const crypto = require('crypto');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const userAgents = require('user-agents');
const readline = require('readline');
const chalk = require('chalk'); // Если у вас chalk v5, используйте require('chalk').default

// Изменяемые настройки (можно менять через интерактивное меню)
let DELAY_BETWEEN_WALLETS = 2000; // Задержка между операциями с кошельками (мс)
let MAX_RETRIES = 3;              // Максимальное число попыток логина
let CHECK_INTERVAL = 60 * 1000;   // Интервал проверки статуса (мс)

// Файл для хранения времени получения бонусов
const CLAIMS_FILE = './claims.json';
let claims = {};
if (fs.existsSync(CLAIMS_FILE)) {
  try {
    claims = JSON.parse(fs.readFileSync(CLAIMS_FILE, 'utf8'));
  } catch (error) {
    console.error('Ошибка загрузки файла claims.json:', error.message);
  }
}
function saveClaims() {
  try {
    fs.writeFileSync(CLAIMS_FILE, JSON.stringify(claims, null, 2));
  } catch (error) {
    console.error('Ошибка сохранения файла claims.json:', error.message);
  }
}

// Загрузка приватных ключей из .env
let privateKeys = [];
if (process.env.PRIVATE_KEY) {
  if (process.env.PRIVATE_KEY.includes(',')) {
    privateKeys = process.env.PRIVATE_KEY.split(',').map(key => key.trim());
  } else {
    privateKeys.push(process.env.PRIVATE_KEY);
  }
}
let keyIndex = 1;
while (process.env[`PRIVATE_KEY_${keyIndex}`]) {
  privateKeys.push(process.env[`PRIVATE_KEY_${keyIndex}`]);
  keyIndex++;
}
if (privateKeys.length === 0) {
  console.error('\x1b[31m%s\x1b[0m', '❌ Ошибка: Не найдено ни одного приватного ключа в .env');
  process.exit(1);
}
console.log(`\n📋 Загружено ${privateKeys.length} приватных ключей из .env`);

// Загрузка прокси из proxies.txt (если есть)
let proxies = [];
try {
  if (fs.existsSync('./proxies.txt')) {
    const proxiesContent = fs.readFileSync('./proxies.txt', 'utf8');
    proxies = proxiesContent
      .split('\n')
      .map(proxy => proxy.trim())
      .filter(proxy => proxy && !proxy.startsWith('#'));
    console.log(`🌐 Загружено ${proxies.length} прокси из proxies.txt`);
  }
} catch (error) {
  console.error('\x1b[33m%s\x1b[0m', `⚠️ Ошибка при загрузке proxies.txt: ${error.message}`);
}

// Функция создания прокси-агента
function createProxyAgent(proxyString) {
  if (!proxyString) return null;
  try {
    if (proxyString.startsWith('socks://') || proxyString.startsWith('socks4://') || proxyString.startsWith('socks5://')) {
      return new SocksProxyAgent(proxyString);
    }
    let formattedProxy = proxyString;
    if (!formattedProxy.includes('://')) {
      if (formattedProxy.includes('@') || !formattedProxy.match(/^\d+\.\d+\.\d+\.\d+:\d+$/)) {
        formattedProxy = `http://${formattedProxy}`;
      } else {
        const [host, port] = formattedProxy.split(':');
        formattedProxy = `http://${host}:${port}`;
      }
    }
    return new HttpsProxyAgent(formattedProxy);
  } catch (error) {
    console.error('\x1b[33m%s\x1b[0m', `⚠️ Ошибка при создании прокси-агента для ${proxyString}: ${error.message}`);
    return null;
  }
}

// Функция получения случайного user-agent
function getRandomUserAgent() {
  const ua = new userAgents({ deviceCategory: 'desktop' });
  return ua.toString();
}

// ASCII‑баннер
function printBanner() {
  process.stdout.write('\x1B[2J\x1B[0f'); // Очистка экрана
  console.log(chalk.yellow(`
        _   _           _  _____      
       | \\ | |         | ||____ |     
       |  \\| | ___   __| |    / /_ __ 
       | . \` |/ _ \\ / _\` |    \\ \\ '__|
       | |\\  | (_) | (_| |.___/ / |   
       \\_| \\_/\\___/ \\__,_|\\____/|_|   

      SyntheliX Manager Bot — скрипт для автоматики  
      TG: @Nod3r
  `));
}

// Функция запуска ноды для кошелька
async function startSynthelixNodeForWallet(privateKey, proxyString, walletLabel, retryCount = 0) {
  const wallet = new ethers.Wallet(privateKey);
  const address = wallet.address;
  const proxyAgent = proxyString ? createProxyAgent(proxyString) : null;
  const userAgent = getRandomUserAgent();

  // Выводим в лог информацию о привязанном прокси (если есть)
  console.log('\x1b[36m%s\x1b[0m', `\n🔄 Запуск ноды для ${walletLabel}: ${address.substring(0, 6)}...${address.substring(address.length - 4)}${proxyString ? ` (используется прокси: ${proxyString})` : ' (без прокси)'}`);

  // Добавляем таймаут (например, 30 секунд) к axiosConfig
  const axiosConfig = {
    httpsAgent: proxyAgent,
    httpAgent: proxyAgent,
    timeout: 30000
  };

  try {
    let cookies = '';
    let csrfToken = '';
    const commonHeaders = {
      'accept': '*/*',
      'content-type': 'application/json',
      'user-agent': userAgent,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Referer': 'https://dashboard.synthelix.io/'
    };

    process.stdout.write('\x1b[90mПолучение списка провайдеров авторизации... \x1b[0m');
    const providersResponse = await axios.get('https://dashboard.synthelix.io/api/auth/providers', {
      ...axiosConfig,
      headers: commonHeaders
    });
    console.log('\x1b[32m%s\x1b[0m', '✓');
    if (providersResponse.headers['set-cookie']) {
      cookies = providersResponse.headers['set-cookie'].join('; ');
    }

    process.stdout.write('\x1b[90mПолучение CSRF токена... \x1b[0m');
    const csrfResponse = await axios.get('https://dashboard.synthelix.io/api/auth/csrf', {
      ...axiosConfig,
      headers: { ...commonHeaders, 'Cookie': cookies }
    });
    console.log('\x1b[32m%s\x1b[0m', '✓');
    csrfToken = csrfResponse.data.csrfToken;
    if (csrfResponse.headers['set-cookie']) {
      cookies = [...(cookies ? [cookies] : []), ...csrfResponse.headers['set-cookie']].join('; ');
    }

    process.stdout.write('\x1b[90mПодготовка подписи сообщения... \x1b[0m');
    const nonce = generateRandomString(32);
    const requestId = Date.now().toString();
    const issuedAt = new Date().toISOString();
    const domain = { name: "Synthelix", version: "1", chainId: 1, verifyingContract: "0x0000000000000000000000000000000000000000" };
    const types = { Authentication: [{ name: "address", type: "address" }, { name: "statement", type: "string" }, { name: "nonce", type: "string" }, { name: "requestId", type: "string" }, { name: "issuedAt", type: "string" }] };
    const value = { address, statement: "Подпишите для входа в Synthelix Dashboard.", nonce, requestId, issuedAt };

    let signature;
    try {
      if (typeof wallet.signTypedData === 'function') {
        signature = await wallet.signTypedData(domain, types, value);
      } else if (typeof wallet._signTypedData === 'function') {
        signature = await wallet._signTypedData(domain, types, value);
      } else {
        const messageString = JSON.stringify({ domain, types, value });
        signature = await wallet.signMessage(ethers.utils.arrayify(ethers.utils.keccak256(ethers.utils.toUtf8Bytes(messageString))));
      }
    } catch (err) {
      const messageToSign = `${address}:${value.statement}:${value.nonce}:${value.requestId}:${value.issuedAt}`;
      signature = await wallet.signMessage(messageToSign);
    }
    console.log('\x1b[32m%s\x1b[0m', '✓');

    process.stdout.write('\x1b[90mАутентификация через web3... \x1b[0m');
    const authData = new URLSearchParams({
      address, signature, domain: JSON.stringify(domain), types: JSON.stringify(types), value: JSON.stringify(value),
      redirect: 'false', callbackUrl: '/', csrfToken, json: 'true'
    });
    const authResponse = await axios.post('https://dashboard.synthelix.io/api/auth/callback/web3', authData.toString(), {
      ...axiosConfig,
      headers: { ...commonHeaders, 'content-type': 'application/x-www-form-urlencoded', 'Cookie': cookies }
    });
    console.log('\x1b[32m%s\x1b[0m', '✓');
    if (authResponse.headers['set-cookie']) {
      cookies = [...(cookies ? [cookies] : []), ...authResponse.headers['set-cookie']].join('; ');
    }

    process.stdout.write('\x1b[90mПолучение сессии... \x1b[0m');
    const sessionResponse = await axios.get('https://dashboard.synthelix.io/api/auth/session', {
      ...axiosConfig,
      headers: { ...commonHeaders, 'Cookie': cookies }
    });
    console.log('\x1b[32m%s\x1b[0m', '✓');
    if (sessionResponse.headers['set-cookie']) {
      cookies = [...(cookies ? [cookies] : []), ...sessionResponse.headers['set-cookie']].join('; ');
    }

    const pointsInfo = await getPointsInfo(cookies, commonHeaders, axiosConfig);
    console.log('\x1b[36m%s\x1b[0m', `💎 Баллы до старта: ${pointsInfo.totalPoints || 0}`);

    const statusInfo = await getNodeStatus(cookies, commonHeaders, axiosConfig);
    if (statusInfo.nodeRunning) {
      process.stdout.write('\x1b[90mОстановка ранее запущенной ноды... \x1b[0m');
      try {
        const timeRunningHours = statusInfo.currentEarnedPoints / statusInfo.pointsPerHour;
        await axios.post('https://dashboard.synthelix.io/api/node/stop', {
          claimedHours: timeRunningHours,
          pointsEarned: statusInfo.currentEarnedPoints
        }, { ...axiosConfig, headers: { ...commonHeaders, 'Cookie': cookies } });
        console.log('\x1b[32m%s\x1b[0m', '✓');
        console.log('\x1b[32m%s\x1b[0m', `💰 Получено ${statusInfo.currentEarnedPoints} баллов`);
        await delay(1000);
      } catch (error) {
        console.log('\x1b[31m%s\x1b[0m', '❌');
        console.error('\x1b[33m%s\x1b[0m', `⚠️ Ошибка при остановке ноды: ${error.message}`);
      }
    }

    process.stdout.write('\x1b[90mЗапуск ноды... \x1b[0m');
    await axios.post('https://dashboard.synthelix.io/api/node/start', null, {
      ...axiosConfig,
      headers: { ...commonHeaders, 'Cookie': cookies }
    });
    console.log('\x1b[32m%s\x1b[0m', '✓');
    console.log('\x1b[32m%s\x1b[0m', `✅ Нода успешно запущена для ${walletLabel}: ${address.substring(0, 6)}...${address.substring(address.length - 4)}!\n`);

    await claimDailyRewards(address, cookies, commonHeaders, axiosConfig, walletLabel);
    const updatedStatusInfo = await getNodeStatus(cookies, commonHeaders, axiosConfig);
    const updatedPointsInfo = await getPointsInfo(cookies, commonHeaders, axiosConfig);

    console.log('\x1b[33m%s\x1b[0m', `\n📊 Статус ноды для ${walletLabel}: ${address.substring(0, 6)}...${address.substring(address.length - 4)}:`);
    console.log('\x1b[33m%s\x1b[0m', `🔄 Состояние ноды: ${updatedStatusInfo.nodeRunning ? 'Запущена' : 'Остановлена'}`);
    console.log('\x1b[33m%s\x1b[0m', `⏱️ Осталось: ${formatTime(updatedStatusInfo.timeLeft)}`);
    console.log('\x1b[33m%s\x1b[0m', `💰 Текущие баллы: ${updatedStatusInfo.currentEarnedPoints || 0}`);
    console.log('\x1b[33m%s\x1b[0m', `💸 Баллов/час: ${updatedStatusInfo.pointsPerHour || 0}`);
    console.log('\x1b[33m%s\x1b[0m', `💎 Всего баллов: ${updatedPointsInfo.totalPoints || 0}`);
    console.log('\x1b[33m%s\x1b[0m', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    return {
      success: true, address, cookies, commonHeaders, axiosConfig,
      timeLeft: updatedStatusInfo.timeLeft, statusInfo: updatedStatusInfo,
      pointsInfo: updatedPointsInfo, walletLabel
    };
  } catch (error) {
    console.log('\x1b[31m%s\x1b[0m', '❌');
    console.error('\x1b[31m%s\x1b[0m', `❌ Ошибка при запуске ноды для ${walletLabel}: ${address.substring(0, 6)}...${address.substring(address.length - 4)}: ${error.message}`);
    if (retryCount < MAX_RETRIES) {
      console.log('\x1b[33m%s\x1b[0m', `⚠️ Повторный запуск ${walletLabel}: ${address.substring(0, 6)}...${address.substring(address.length - 4)} (Попытка ${retryCount + 1}/${MAX_RETRIES})...`);
      await delay(5000);
      return startSynthelixNodeForWallet(privateKey, proxyString, walletLabel, retryCount + 1);
    }
    return { success: false, address, error: error.message, walletLabel };
  }
}

// Функция получения ежедневных бонусов с проверкой времени
async function claimDailyRewards(address, commonHeaders, axiosConfig, walletLabel, cookies) {
  const lastClaimTime = claims[address];
  const now = Date.now();
  const ONE_DAY = 24 * 3600 * 1000;
  
  if (lastClaimTime && (now - lastClaimTime) < ONE_DAY) {
    console.log('\x1b[33m%s\x1b[0m', 
      `ℹ️ Ежедневные бонусы уже получены для ${walletLabel}: ${address.substring(0, 6)}...${address.substring(address.length - 4)}. ` +
      `Следующий бонус через ${formatTime(Math.floor((ONE_DAY - (now - lastClaimTime)) / 1000))}.`);
    return false;
  }
  
  try {
    process.stdout.write('\x1b[90mПолучение ежедневных бонусов... \x1b[0m');
    const updatedHeaders = { ...commonHeaders, 'Cookie': cookies, 'Referer': 'https://dashboard.synthelix.io/' };
    await axios.post('https://dashboard.synthelix.io/api/rew/dailypoints', { points: 1000 }, {
      ...axiosConfig,
      headers: updatedHeaders
    });
    console.log('\x1b[32m%s\x1b[0m', '✓');
    console.log('\x1b[32m%s\x1b[0m', `💰 Получено 1000 ежедневных баллов для ${walletLabel}: ${address.substring(0, 6)}...${address.substring(address.length - 4)}`);
    
    // Обновляем время получения бонуса и сохраняем
    claims[address] = now;
    saveClaims();
    return true;
  } catch (error) {
    console.log('\x1b[31m%s\x1b[0m', '❌');
    console.error('\x1b[33m%s\x1b[0m', `⚠️ Не удалось получить ежедневные бонусы: ${error.message}`);
    if (error.response && error.response.data && error.response.data.error === 'Already claimed today') {
      console.log('\x1b[33m%s\x1b[0m', 
        `ℹ️ Ежедневные бонусы уже получены для ${walletLabel}: ${address.substring(0, 6)}...${address.substring(address.length - 4)}`);
      claims[address] = now;
      saveClaims();
    }
    return false;
  }
}

// Функция получения статуса ноды
async function getNodeStatus(cookies, commonHeaders, axiosConfig) {
  try {
    process.stdout.write('\x1b[90mПолучение статуса ноды... \x1b[0m');
    const updatedHeaders = { ...commonHeaders, 'Cookie': cookies, 'Referer': 'https://dashboard.synthelix.io/' };
    const response = await axios.get('https://dashboard.synthelix.io/api/node/status', {
      ...axiosConfig,
      headers: updatedHeaders
    });
    console.log('\x1b[32m%s\x1b[0m', '✓');
    return response.data;
  } catch (error) {
    console.log('\x1b[31m%s\x1b[0m', '❌');
    console.error('\x1b[33m%s\x1b[0m', `⚠️ Не удалось получить статус ноды: ${error.message}`);
    return { nodeRunning: false, timeLeft: 0, currentEarnedPoints: 0, pointsPerHour: 0 };
  }
}

// Функция получения информации о баллах
async function getPointsInfo(cookies, commonHeaders, axiosConfig) {
  try {
    process.stdout.write('\x1b[90mПолучение информации о баллах... \x1b[0m');
    const updatedHeaders = {
      ...commonHeaders,
      'accept': '*/*',
      'accept-language': 'ru-RU,ru;q=0.9',
      'sec-ch-ua': '"Brave";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-gpc': '1',
      'Cookie': cookies,
      'Referer': 'https://dashboard.synthelix.io/'
    };
    const response = await axios.get('https://dashboard.synthelix.io/api/get/points', {
      ...axiosConfig,
      headers: updatedHeaders
    });
    console.log('\x1b[32m%s\x1b[0m', '✓');
    return { totalPoints: response.data.points || 0 };
  } catch (error) {
    console.log('\x1b[31m%s\x1b[0m', '❌');
    console.error('\x1b[33m%s\x1b[0m', `⚠️ Не удалось получить информацию о баллах: ${error.message}`);
    return { totalPoints: 0 };
  }
}

// Функция форматирования времени
function formatTime(seconds) {
  if (!seconds) return '0c';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  let result = '';
  if (hours > 0) result += `${hours}ч `;
  if (minutes > 0 || hours > 0) result += `${minutes}м `;
  result += `${remainingSeconds}с`;
  return result.trim();
}

// Функция генерации случайной строки
function generateRandomString(length) {
  return crypto.randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length)
    .replace(/[^a-zA-Z0-9]/g, '')
    .replace(/(.{1,4})/g, (m) => Math.random() > 0.5 ? m.toUpperCase() : m);
}

// Функция задержки
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* 
  Функция мониторинга нод (один цикл).
  Если inLoop === true, не запрашивается "Нажмите Enter для возврата в меню..."
*/
async function monitorNodesOnce(inLoop = false) {
  console.clear();
  printBanner();
  console.log(`🔍 Проверка ${privateKeys.length} кошельков — ${new Date().toLocaleString()}\n`);

  let activeWallets = 0;
  const walletSessions = {};

  // Инициализируем сессии для каждого кошелька
  for (let i = 0; i < privateKeys.length; i++) {
    const privateKey = privateKeys[i];
    const walletLabel = `Кошелёк ${i + 1}`;
    const proxy = proxies.length > 0 ? proxies[i % proxies.length] : null;
    const result = await startSynthelixNodeForWallet(privateKey, proxy, walletLabel);
    if (result.success) {
      walletSessions[result.address] = result;
      activeWallets++;
    }
    if (i < privateKeys.length - 1) await delay(DELAY_BETWEEN_WALLETS);
  }

  // Проверяем состояние нод
  for (let i = 0; i < privateKeys.length; i++) {
    const privateKey = privateKeys[i];
    const wallet = new ethers.Wallet(privateKey);
    const address = wallet.address;
    const walletLabel = `Кошелёк ${i + 1}`;
    const shortAddress = `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
    const proxy = proxies.length > 0 ? proxies[i % proxies.length] : null;

    try {
      if (walletSessions[address] && walletSessions[address].cookies) {
        const session = walletSessions[address];
        const statusInfo = await getNodeStatus(session.cookies, session.commonHeaders, session.axiosConfig);
        const pointsInfo = await getPointsInfo(session.cookies, session.commonHeaders, session.axiosConfig);

        console.log('\x1b[36m%s\x1b[0m', `${walletLabel}: ${shortAddress}`);
        console.log('\x1b[33m%s\x1b[0m', `Состояние: ${statusInfo.nodeRunning ? 'Запущена' : 'Остановлена'}`);
        console.log('\x1b[33m%s\x1b[0m', `Осталось: ${formatTime(statusInfo.timeLeft)}`);
        console.log('\x1b[33m%s\x1b[0m', `Текущие баллы: ${statusInfo.currentEarnedPoints || 0}`);
        console.log('\x1b[33m%s\x1b[0m', `Баллов/час: ${statusInfo.pointsPerHour || 0}`);
        console.log('\x1b[33m%s\x1b[0m', `Всего баллов: ${pointsInfo.totalPoints || 0}`);
        console.log('');

        if (!statusInfo.nodeRunning || statusInfo.timeLeft < 600) {
          console.log('\x1b[33m%s\x1b[0m', `⚠️ Нода требует перезапуска для ${walletLabel}: ${shortAddress}`);
          if (statusInfo.nodeRunning && statusInfo.currentEarnedPoints > 0) {
            process.stdout.write('\x1b[90mОстановка ноды для получения баллов... \x1b[0m');
            try {
              const timeRunningHours = statusInfo.currentEarnedPoints / statusInfo.pointsPerHour;
              await axios.post('https://dashboard.synthelix.io/api/node/stop', {
                claimedHours: timeRunningHours,
                pointsEarned: statusInfo.currentEarnedPoints
              }, { ...session.axiosConfig, headers: { ...session.commonHeaders, 'Cookie': session.cookies } });
              console.log('\x1b[32m%s\x1b[0m', '✓');
              console.log('\x1b[32m%s\x1b[0m', `💰 Получено ${statusInfo.currentEarnedPoints} баллов`);
              await delay(1000);
            } catch (error) {
              console.log('\x1b[31m%s\x1b[0m', '❌');
              console.error('\x1b[33m%s\x1b[0m', `⚠️ Ошибка при остановке ноды: ${error.message}`);
            }
          }
          process.stdout.write('\x1b[90mЗапуск ноды... \x1b[0m');
          await axios.post('https://dashboard.synthelix.io/api/node/start', null, {
            ...session.axiosConfig,
            headers: { ...session.commonHeaders, 'Cookie': session.cookies }
          });
          console.log('\x1b[32m%s\x1b[0m', '✓');
          await claimDailyRewards(address, session.cookies, session.commonHeaders, session.axiosConfig, walletLabel);
          const updatedStatus = await getNodeStatus(session.cookies, session.commonHeaders, session.axiosConfig);
          const updatedPoints = await getPointsInfo(session.cookies, session.commonHeaders, session.axiosConfig);
          walletSessions[address].timeLeft = updatedStatus.timeLeft;
          walletSessions[address].statusInfo = updatedStatus;
          walletSessions[address].pointsInfo = updatedPoints;
        }
      } else {
        console.log('\x1b[33m%s\x1b[0m', `⚠️ Сессия для ${walletLabel}: ${shortAddress} истекла, повторный вход...`);
        const result = await startSynthelixNodeForWallet(privateKey, proxy, walletLabel);
        if (result.success) {
          walletSessions[address] = result;
        }
      }
    } catch (error) {
      console.error('\x1b[31m%s\x1b[0m', `❌ Ошибка ${walletLabel}: ${shortAddress}: ${error.message}`);
    }
    if (i < privateKeys.length - 1) await delay(DELAY_BETWEEN_WALLETS);
  }

  console.log('\x1b[36m%s\x1b[0m', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log('\x1b[36m%s\x1b[0m', `Итого:`);
  console.log(`Всего кошельков: ${privateKeys.length}`);
  console.log(`Активных нод: ${activeWallets}`);
  const nextCheckTime = new Date(Date.now() + CHECK_INTERVAL);
  console.log(`Следующая проверка: ${nextCheckTime.toLocaleString()}`);
  console.log('\x1b[36m%s\x1b[0m', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  if (!inLoop) {
    await askQuestion('Нажмите Enter для возврата в меню...');
  }
}

/* 
  Функция бесконечного мониторинга нод.
  Вызывает monitorNodesOnce(true) в бесконечном цикле.
*/
async function monitorNodesInfinite() {
  while (true) {
    await monitorNodesOnce(true);
    await delay(CHECK_INTERVAL);
  }
}

/* ---------------------- Интерактивное меню ---------------------- */
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});
function askQuestion(query) {
  return new Promise(resolve => rl.question(query, ans => resolve(ans.trim())));
}
async function addPrivateKey() {
  const newKey = await askQuestion('Введите новый приватный ключ: ');
  if (newKey) {
    privateKeys.push(newKey);
    console.log('✅ Приватный ключ успешно добавлен!');
  } else {
    console.log('⚠️ Приватный ключ не был введён.');
  }
}
async function addProxy() {
  const newProxy = await askQuestion('Введите новый прокси (в формате host:port или с указанием схемы): ');
  if (newProxy) {
    proxies.push(newProxy);
    console.log('✅ Прокси успешно добавлен!');
  } else {
    console.log('⚠️ Прокси не был введён.');
  }
}
function showInfo() {
  console.log('\n📋 Текущие настройки:');
  console.log(`Приватных ключей: ${privateKeys.length}`);
  console.log(`Прокси: ${proxies.length}`);
  if (privateKeys.length > 0) {
    console.log('Список приватных ключей (первые 6 и последние 4 символа):');
    privateKeys.forEach((key, idx) => {
      console.log(`  [${idx + 1}] ${key.substring(0, 6)}...${key.substring(key.length - 4)}`);
    });
  }
  if (proxies.length > 0) {
    console.log('Список прокси:');
    proxies.forEach((p, idx) => console.log(`  [${idx + 1}] ${p}`));
  }
  console.log('');
}

async function editConstants() {
  console.log('\n📋 Текущие настройки задержек:');
  console.log(`1. DELAY_BETWEEN_WALLETS: ${DELAY_BETWEEN_WALLETS} мс`);
  console.log(`2. MAX_RETRIES: ${MAX_RETRIES}`);
  console.log(`3. CHECK_INTERVAL: ${CHECK_INTERVAL} мс`);
  console.log("Введите новое значение или оставьте пустым для сохранения текущего.");
  
  let input = await askQuestion("Новое значение для DELAY_BETWEEN_WALLETS (или 'r' для случайного, диапазон 1000-5000): ");
  if (input.trim().toLowerCase() === 'r') {
    DELAY_BETWEEN_WALLETS = Math.floor(Math.random() * (5000 - 1000 + 1)) + 1000;
    console.log("Случайное значение установлено: " + DELAY_BETWEEN_WALLETS);
  } else if (input.trim()) {
    let newVal = parseInt(input);
    if (!isNaN(newVal)) DELAY_BETWEEN_WALLETS = newVal;
  }
  
  input = await askQuestion("Новое значение для MAX_RETRIES (или 'r' для случайного, диапазон 1-5): ");
  if (input.trim().toLowerCase() === 'r') {
    MAX_RETRIES = Math.floor(Math.random() * (5 - 1 + 1)) + 1;
    console.log("Случайное значение установлено: " + MAX_RETRIES);
  } else if (input.trim()) {
    let newVal = parseInt(input);
    if (!isNaN(newVal)) MAX_RETRIES = newVal;
  }
  
  input = await askQuestion("Новое значение для CHECK_INTERVAL (мс) (или 'r' для случайного, диапазон 30000-120000): ");
  if (input.trim().toLowerCase() === 'r') {
    CHECK_INTERVAL = Math.floor(Math.random() * (120000 - 30000 + 1)) + 30000;
    console.log("Случайное значение установлено: " + CHECK_INTERVAL);
  } else if (input.trim()) {
    let newVal = parseInt(input);
    if (!isNaN(newVal)) CHECK_INTERVAL = newVal;
  }
  
  console.log("\nНовые настройки:");
  console.log(`DELAY_BETWEEN_WALLETS: ${DELAY_BETWEEN_WALLETS} мс`);
  console.log(`MAX_RETRIES: ${MAX_RETRIES}`);
  console.log(`CHECK_INTERVAL: ${CHECK_INTERVAL} мс`);
  await askQuestion('Нажмите Enter для возврата в меню...');
}

async function mainMenu() {
  while (true) {
    printBanner();
    console.log('Выберите действие:');
    console.log('1. Запустить автоподдержку нод (один цикл проверки)');
    console.log('2. Запустить автоподдержку нод (бесконечный цикл)');
    console.log('3. Добавить новый приватный ключ');
    console.log('4. Добавить новый прокси-сервер');
    console.log('5. Вывести информацию о настройках');
    console.log('6. Изменить настройки задержек');
    console.log('7. Выход');
    const answer = await askQuestion('\nВведите номер действия: ');
    switch (answer) {
      case '1':
        console.log('🔄 Запуск автоподдержки нод. Выполняется один цикл проверки...\n');
        await monitorNodesOnce();
        break;
      case '2':
        console.log('🔄 Запуск автоподдержки нод (бесконечный цикл). Для остановки нажмите Ctrl+C.\n');
        await monitorNodesInfinite();
        break;
      case '3':
        await addPrivateKey();
        await askQuestion('Нажмите Enter для возврата в меню...');
        break;
      case '4':
        await addProxy();
        await askQuestion('Нажмите Enter для возврата в меню...');
        break;
      case '5':
        showInfo();
        await askQuestion('Нажмите Enter для возврата в меню...');
        break;
      case '6':
        await editConstants();
        break;
      case '7':
        console.log('Выход из программы. До свидания!');
        rl.close();
        process.exit(0);
      default:
        console.log('⚠️ Неверный выбор, попробуйте еще раз.');
        await askQuestion('Нажмите Enter для возврата в меню...');
    }
  }
}

mainMenu();