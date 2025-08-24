require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { WebClient } = require('@slack/web-api');
const crypto = require('crypto');
const emoji = require('emoji-dictionary');
const axios = require('axios')
const fetch = require('node-fetch');

const app = express();
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'app')));

const EMOJI_FILE = path.join(__dirname, 'emoji.json'); // storing em emojis in a MASSIVE json file. do you know what else is MASSIVE?
const HACKATIME_BASE = "https://hackatime.hackclub.com"; // base hackatime url?!!??!?! :shocked:

async function refreshEmojis() {
    try {
        const result = await slack.emoji.list();
        if (result.ok) {
            fs.writeFileSync(EMOJI_FILE, JSON.stringify(result.emoji, null, 2));
        } else {
            console.error('[Emoji] Failed to fetch emoji list :c bc', result.error);
        }
    } catch (err) {
        console.error('[Emoji] Error refreshing emoji list:', err.message);
    }
}

refreshEmojis();
setInterval(refreshEmojis, 60 * 1000);

async function fetchHackatimeData(slackUid) {
    const headers = { Authorization: `Bearer ${process.env.HACKATIME_API_KEY}` };

    try {
        const statsRes = await axios.get(
            `${HACKATIME_BASE}/api/v1/users/${slackUid}/stats`,
            { headers }
        );

        function normalizeName(name) {
            return name.toLowerCase().replace(/\s+/g, "");
        }

        function getIconUrl(name) {
            const normalized = normalizeName(name);

            const deviconMap = {
                html: "html5",
                css: "css3",
                js: "javascript",
                javascript: "javascript",
                ts: "typescript",
                typescript: "typescript",
                py: "python",
                python: "python",
                java: "java",
                c: "c",
                cpp: "cplusplus",
                "c++": "cplusplus",
                cs: "csharp",
                "c#": "csharp",
                ruby: "ruby",
                go: "go",
                php: "php",
                rust: "rust",
                sql: "mysql",
                bash: "bash",
                sh: "bash",
                shell: "bash",
                json: "json",
                html5: "html5",
                css3: "css3",
                node: "nodejs",
                nodejs: "nodejs"
            };

            const slug = deviconMap[normalized];

            if (slug) {
                return `https://cdn.jsdelivr.net/gh/devicons/devicon/icons/${slug}/${slug}-original.svg`;
            }

            return `https://cdn.jsdelivr.net/gh/lucide-icons/lucide/icons/plus.svg`;
        }

        const languages = (statsRes.data?.data?.languages || [])
            .map(lang => ({
                name: normalizeName(lang.name),
                time: lang.text,
                seconds: lang.total_seconds || 0,
                imageUrl: getIconUrl(lang.name)
            }))
            .sort((a, b) => b.seconds - a.seconds);

        const topLanguages = languages.slice(0, 3);

        return {
            lifetimeCodingTime: `${Math.floor((statsRes.data?.data?.total_seconds || 0) / 3600)}h`,
            dailyAverage: statsRes.data?.data?.human_readable_daily_average || "0m",
            hackatimeTrustFactor: statsRes.data?.trust_factor?.trust_level === "blue" 
            ? "Unanalyzed"
            : statsRes.data?.trust_factor?.trust_level === "red" 
            ? "Banned"
            : statsRes.data?.trust_factor?.trust_level === "yellow"
            ? "Suspected"
            : statsRes.data?.trust_factor?.trust_level === "green"
            ? "Trusted"
            : statsRes.data?.trust_factor?.trust_level || "unknown",
            topLanguages
        };
    } catch (err) {
        console.error("[Hackatime] API fetch error:", err.message);
        return {
            lifetimeCodingTime: "N/A",
            dailyAverage: "N/A",
            hackatimeTrustFactor: "N/A",
            topLanguages: []
        };
    }
}

app.get('/:memberId', async (req, res) => {
    const memberId = req.params.memberId;

    try {
        const userInfo = await slack.users.info({ user: memberId });
        const username = userInfo.user.profile.display_name || userInfo.user.real_name;
        let pfp = userInfo.user.profile.image_original;

        if (!pfp) {
            const email = userInfo.user.profile.email || '';
            const hash = crypto.createHash('md5').update(email.trim().toLowerCase()).digest('hex');
            pfp = `https://www.gravatar.com/avatar/${hash}?d=identicon`;
        }

        let statusEmoji = userInfo.user.profile.status_emoji;
        let statusText = userInfo.user.profile.status_text;

        let profileInfo;
        try {
            profileInfo = await slack.users.profile.get({ user: memberId });
        } catch (err) {
            console.error(`[Profile] Failed to fetch profile for ${memberId}:`, err.message);
        }

        if (!statusEmoji && !statusText) {
            statusText = profileInfo?.profile?.title || profileInfo?.profile?.real_name || "";
        }

        const multiChannel = userInfo.user.is_restricted; // multi channel
        const singleChannel = userInfo.user.is_ultra_restricted; // single channel
        const admin = userInfo.user.is_admin;
        const bot = userInfo.user.is_bot;

        let emojiMap = {};
        if (fs.existsSync(EMOJI_FILE)) {
            emojiMap = JSON.parse(fs.readFileSync(EMOJI_FILE, 'utf8'));
        }

        let statusEmojiHtml = '';
        if (statusEmoji) {
            const emojiName = statusEmoji.replace(/:/g, '');

            if (emojiMap[emojiName]) {
                statusEmojiHtml = `<img src="${emojiMap[emojiName]}" style="width: 1em; height: 1em;" alt="${statusEmoji}">`;
            } else {
                const unicodeEmoji = emoji.getUnicode(emojiName);
                if (unicodeEmoji) {
                    statusEmojiHtml = unicodeEmoji;
                } else {
                    statusEmojiHtml = statusEmoji;
                }
            }
        } else {
            statusEmojiHtml = `<span id="statusEmoji" style="display: none;"></span>`;
        }

        const hackatimeData = await fetchHackatimeData(memberId);

        const templatePath = path.join(__dirname, 'app', 'profile.html');
        fs.readFile(templatePath, 'utf8', (err, data) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error loading profile template.');
            }

            let html = data
                .replace(/{{username}}/g, username)
                .replace(/{{pfp}}/g, pfp)
                .replace(/{{statusEmoji}}/g, statusEmojiHtml)
                .replace(/{{statusText}}/g, statusText)
                .replace(/{{memberId}}/g, memberId)
                .replace(/{{lifetimeCodingTime}}/g, hackatimeData.lifetimeCodingTime)
                .replace(/{{dailyAverage}}/g, hackatimeData.dailyAverage)
                .replace(/{{hackatimeTrustFactor}}/g, hackatimeData.hackatimeTrustFactor)
                .replace(
                    /{{topLanguages}}/g,
                    hackatimeData.topLanguages
                        .map(lang => `<div class="lang-badge">
                                        <img src="${lang.imageUrl}" alt="${lang.name} Icon" title="${lang.name}"/>
                                      </div>`)
                        .join("")
                );

            if (multiChannel) {
                html = html.replace("</body>", "<script>addHeader('This user is a multi-channel guest and can only access a few channels!', 'neutral')</script></body>");
            } else if (singleChannel) {
                html = html.replace("</body>", "<script>addHeader('This user is a single-channel guest and can only acess a single channel!', 'neutral')</script></body>");
            } else if (admin) {
                html = html.replace("</body>", "<script>addHeader('This user is an admin, beware!', 'warning')</script></body>");
            } else if (bot) {
                html = html.replace("</body>", "<script>addHeader('This is a bot. Please do not send them your freaky messages.', 'neutral')</script></body>");
            }

            res.send(html);
        });
    } catch (error) {
        res.status(404).send(`<h1>No user found with ID: ${memberId}</h1>`)
    }
});

const PORT = 0;
const server = app.listen(PORT, () => {
    const REALPORT = server.address().port;
    console.log(`thanks for locally hosting "UserRate"!`);
    console.log(`the website is now running on http://localhost:${REALPORT}, congratulations!`);
});