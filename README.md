<!-- ROSEVPN-BANNER-START -->
<p align="center">
  <a href="https://t.me/rosevpnru_bot">
    <img alt="RoseVPN — быстрый VPN" src="https://img.shields.io/badge/%F0%9F%8C%B9%20RoseVPN-%D0%9F%D0%BE%D0%B4%D0%BA%D0%BB%D1%8E%D1%87%D0%B8%D1%82%D1%8C%D1%81%D1%8F%20%D0%B2%20Telegram-E63946?style=for-the-badge&logo=telegram&logoColor=white&labelColor=1a1a1a" height="40"/>
  </a>
</p>
<p align="center">
  <sub><b>Быстрый VPN с обходом YouTube, Discord, Instagram</b> · Бесплатный пробный период · Подключение за 30 секунд через бот <a href="https://t.me/rosevpnru_bot">@rosevpnru_bot</a></sub>
</p>

---

<!-- ROSEVPN-BANNER-END -->

# UnblockPro — Обход блокировок Discord и YouTube


<p align="center">
  <strong>Автоматический DPI bypass для macOS и Windows</strong><br>
  Разблокируй Discord, YouTube и другие сервисы в один клик
</p>

<p align="center">
  <a href="https://github.com/by-sonic/unblock-pro/releases/latest"><img src="https://img.shields.io/github/v/release/by-sonic/unblock-pro?style=for-the-badge&color=blue&label=version" alt="Version"></a>
  <a href="https://github.com/by-sonic/unblock-pro/releases/latest"><img src="https://img.shields.io/github/downloads/by-sonic/unblock-pro/total?style=for-the-badge&color=green&label=downloads" alt="Downloads"></a>
  <a href="https://github.com/by-sonic/unblock-pro/blob/main/LICENSE"><img src="https://img.shields.io/github/license/by-sonic/unblock-pro?style=for-the-badge&color=purple" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blue?style=for-the-badge" alt="Platform">
</p>

---

## Скачать

| Платформа | Файл | Описание |
|-----------|------|----------|
| **macOS** Apple Silicon (M1/M2/M3/M4) | [UnblockPro-mac-arm64.dmg / .zip](https://github.com/by-sonic/unblock-pro/releases/latest) | Для Mac с M-процессором |
| **macOS** Intel | [UnblockPro-mac-x64.dmg / .zip](https://github.com/by-sonic/unblock-pro/releases/latest) | Для Mac с Intel |
| **Windows** | [UnblockPro-win-setup.exe](https://github.com/by-sonic/unblock-pro/releases/latest) | Установщик |
| **Windows** | [UnblockPro-win-portable.exe](https://github.com/by-sonic/unblock-pro/releases/latest) | Портативная версия (без установки) |

> Перейдите в [Releases](https://github.com/by-sonic/unblock-pro/releases/latest) и скачайте версию для вашей ОС

### Системные требования

- **Windows 10 / 11 (x64).** Windows 7 и 8 не поддерживаются: движок обхода (WinDivert + runtime сборки Flowseal) использует системные API, которых там нет. Для Win7 смотрите [ByeDPI Manager](https://github.com/BDManual/ByeDPIManager-Manual/blob/main/win7.md).
- **macOS 11 Big Sur или новее**, Intel и Apple Silicon (universal-бинарник `tpws` вложен в приложение).

### Другие платформы

Версии под Android и Linux не планируются — приложение написано на Electron и завязано на десктопные механизмы обхода. Готовые решения на том же принципе:

- **Android:** [ByeDPI для Android](https://github.com/dovecoteescapee/ByeDPIAndroid), порты [zapret](https://github.com/bol-van/zapret) под Android
- **Linux:** оригинальный [bol-van/zapret](https://github.com/bol-van/zapret) (nfqws/tpws, ставится скриптом `install_easy.sh`)

---

## Что нового в Windows

- Все 20 стратегий `general*.bat` синхронизированы с [Flowseal/zapret-discord-youtube 1.9.9c](https://github.com/Flowseal/zapret-discord-youtube/releases/tag/1.9.9c), включая новую `ALT12`; `ALT9` проверяется первой
- Добавлены актуальные Discord/STUN payload-файлы, TCP/UDP-профили, игровые правила и порт `8443`
- Совместимый runtime входит в приложение, а скачанный bundle проверяется по SHA-256
- Списки доменов и исключений обновлены до версии Flowseal `1.9.9c`
- Автоподбор проверяет не только страницы, но и YouTube video redirect, Discord CDN и WebSocket gateway

---

## Что это?

**UnblockPro** — десктопное приложение для обхода DPI-блокировок, которое позволяет пользоваться Discord, YouTube и другими сервисами без VPN. Работает на macOS и Windows.

### Ключевые возможности

- **Один клик** — нажмите «Подключить» и всё заработает
- **Автоматический подбор стратегии** — приложение само находит рабочий метод обхода для вашего провайдера
- **Проверка подключения** — стратегия проверяется реальным запросом, а не гаданием
- **macOS + Windows** — полная поддержка обеих платформ
- **Автозапуск** — запускается вместе с системой
- **Автоподключение** — подключается автоматически при старте
- **Системный трей** — работает в фоне, не мешает
- **Безопасная очистка** — прокси-настройки автоматически сбрасываются при выходе

---

## Как это работает

UnblockPro использует технологию [zapret](https://github.com/bol-van/zapret) для обхода Deep Packet Inspection (DPI):

| Платформа | Метод |
|-----------|-------|
| **macOS** | `tpws` — SOCKS5 прокси с модификацией пакетов. Приложение автоматически настраивает системный прокси |
| **Windows** | `winws` — перехватывает пакеты на уровне драйвера через WinDivert. Стратегия `ALT9` и runtime синхронизированы с Flowseal `1.9.9c` |

Приложение последовательно тестирует несколько стратегий (split+disorder, split-tls, methodeol, oob и другие), пока не найдёт работающую для вашего провайдера.

---

## Установка

### macOS

1. Скачайте `UnblockPro-*-mac.zip` из [Releases](https://github.com/by-sonic/unblock-pro/releases/latest)
2. Распакуйте ZIP и перетащите `UnblockPro.app` в папку «Программы»
3. **Откройте Терминал** и выполните команду:

```bash
xattr -cr /Applications/UnblockPro.app
```

4. Запустите приложение и нажмите «Подключить»

Обновления на macOS устанавливаются вручную со страницы Releases: неподписанное приложение нельзя безопасно заменить через системный автообновлятор. Приложение покажет новую версию и откроет нужную страницу.

> **Зачем нужна команда?** macOS блокирует приложения без платной подписи Apple Developer ($99/год). Команда `xattr -cr` снимает карантинный флаг — это безопасно, код проекта полностью открыт. Работает на Intel и Apple Silicon (M1/M2/M3).

### Windows

1. Скачайте установщик или портативную версию из [Releases](https://github.com/by-sonic/unblock-pro/releases/latest)
2. Запустите от имени администратора
3. Нажмите «Подключить»

> **Важно:** На Windows требуются права администратора для работы WinDivert

---

## Скриншоты

<p align="center">
  <em>Главный экран — статус подключения, управление в один клик</em>
</p>

---

## FAQ

<details>
<summary><strong>Это VPN?</strong></summary>
Нет. UnblockPro не шифрует трафик и не маршрутизирует его через удалённый сервер. Он модифицирует сетевые пакеты локально, чтобы DPI-системы провайдера не могли распознать и заблокировать запросы к Discord/YouTube.
</details>

<details>
<summary><strong>Безопасно ли это?</strong></summary>
Да. Приложение open-source, не собирает данные, не отправляет трафик через сторонние серверы. Весь код доступен для аудита.
</details>

<details>
<summary><strong>Что если приложение крашнется?</strong></summary>
Прокси-настройки автоматически сбрасываются при любом завершении: штатном, аварийном или через kill. При следующем запуске настройки также очищаются для надёжности.
</details>

<details>
<summary><strong>Discord/YouTube всё ещё не работает</strong></summary>
Попробуйте отключиться и подключиться заново — приложение переберёт другие стратегии. Если ни одна не помогла, возможно, ваш провайдер использует продвинутый DPI — создайте Issue.
</details>

<details>
<summary><strong>Как добавить свой домен?</strong></summary>
Откройте блок «Свои домены», добавьте корневой домен без `https://` и пути, затем отключитесь и подключитесь снова. Поддомены учитываются автоматически.
</details>

<details>
<summary><strong>macOS: «файл не был открыт» / Gatekeeper</strong></summary>

Откройте Терминал и выполните:
```bash
xattr -cr /Applications/UnblockPro.app
```
После этого приложение запустится нормально. Это нужно сделать только один раз.

Если скачали `.zip` и распаковали в другую папку — укажите путь к `.app` вместо `/Applications/UnblockPro.app`.
</details>

---

## Разработка

```bash
# Клонировать репозиторий
git clone https://github.com/by-sonic/unblock-pro.git
cd unblock-pro

# Установить зависимости
npm install

# Запустить в режиме разработки
npm start

# Собрать для текущей ОС
npm run build

# Собрать для macOS
npm run build:mac

# Собрать для Windows
npm run build:win

# Перерисовать иконки из assets/*.svg (нужно после правки знака)
npm run build:icons
```

### Иконки

Знак живёт в трёх SVG в `assets/`: `icon.svg` (приложение), `tray-icon.svg` (строка меню macOS, чёрный по прозрачному — template image) и `tray-badge.svg` (трей Windows). Геометрия нарисована на сетке 16 единиц и только масштабируется, поэтому края попадают на целый пиксель во всех размерах.

`npm run build:icons` растеризует их через Electron и пакует `.ico`/`.icns` — сторонних зависимостей не нужно. Результаты коммитятся в репозиторий: сборка иконки не рисует. Контрольный лист всех размеров — `assets/icon-preview.html`.

---

## Стек

- **Electron** — кроссплатформенный фреймворк
- **zapret** — движок обхода DPI ([bol-van/zapret](https://github.com/bol-van/zapret))
- **electron-builder** — сборка и дистрибуция
- **GitHub Actions** — автоматические билды при релизе

---

## Лицензия

[MIT](LICENSE) — свободное использование, модификация и распространение.

---

<p align="center">
  <strong>by sonic</strong><br>
  <sub>Если проект помог — поставь ⭐️</sub>
</p>

---

### Ключевые слова / Keywords

> discord разблокировка, youtube разблокировка, обход блокировки discord, обход блокировки youtube, dpi bypass, антиблокировка, разблокировать дискорд, discord россия, youtube россия, zapret gui, обход dpi, discord unblock russia, youtube unblock russia, anti dpi, bypass discord block, unblock discord, unblock youtube
