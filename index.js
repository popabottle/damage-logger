const { Client, GatewayIntentBits, Partials } = require('discord.js');
const express = require('express');

// --- 1. CONFIGURATION AND INITIALIZATION ---

// Retrieve environment variables from Render Environment Variables
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL;
// --- MODIFIED: Renamed to ADMIN_ROLE_IDS and will contain a comma-separated list of IDs ---
const ADMIN_ROLE_IDS_STRING = process.env.ADMIN_ROLE_IDS; 

// --- NEW/MODIFIED CHANNEL IDs ---
const GOLD_CHANNEL_ID = process.env.GOLD_CHANNEL_ID; 
const DAMAGE_CATEGORY_ID = process.env.DAMAGE_CATEGORY_ID; // The ID of the Forum/Category holding the damage threads
const VERIFICATION_CHANNEL_ID = process.env.VERIFICATION_CHANNEL_ID; // The central channel where all pending logs are posted

// --- CRITICAL: Split the string of IDs into an array for easy checking ---
const ADMIN_ROLE_IDS = ADMIN_ROLE_IDS_STRING ? ADMIN_ROLE_IDS_STRING.split(',').map(id => id.trim()) : [];


// Ensure all environment variables are set
if (!DISCORD_TOKEN || !GOLD_CHANNEL_ID || !DAMAGE_CATEGORY_ID || !VERIFICATION_CHANNEL_ID || !WEB_APP_URL || ADMIN_ROLE_IDS.length === 0) {
    console.error("ERROR: One or more required environment variables are missing, or ADMIN_ROLE_IDS is empty.");
    process.exit(1);
}

// Initialize Discord Client with necessary intents for reactions and message content
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions 
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// A temporary place to store verification data (Key: Verification Message ID -> Value: { type, player, value, originalTimestampMs })
// We store this data on the NEW message in the verification channel.
const pendingVerifications = new Map();

// --- 2. BOT READY & SERVER STARTUP (For Render's health check) ---

client.on('ready', () => {
    console.log(`Bot logged in as ${client.user.tag}!`);
    startServer();
});


/**
 * Sets up a simple Express server to handle health checks and ensure the service stays running on Render.
 */
function startServer() {
    const app = express();
    const port = process.env.PORT || 3000; 

    app.get('/', (req, res) => {
        res.send('Bot is awake and running!');
    });

    app.listen(port, () => {
        console.log(`Keep-Alive/Health Check Server listening on port ${port}.`);
    });
}

// --- 3. LISTENING FOR NEW MESSAGES (Routes Logs to Central Channel) ---

client.on('messageCreate', async message => {
    
    // Ignore messages from the bot itself
    if (message.author.bot) return;

    let type = null;
    let player = null;
    let value = null;
    let sourceChannel = message.channel; // Store the original channel object
    
    // Get the original message's creation timestamp (in milliseconds)
    const originalTimestampMs = message.createdTimestamp;

    // --- LOGIC FOR GOLD DONATIONS (Simple admin channel) ---
    if (message.channelId === GOLD_CHANNEL_ID) {
        // Gold format: gold: PlayerName Value
        const content = message.content.trim().split(':');
        if (content.length < 2) return; 

        const parsedType = content[0].trim().toLowerCase(); 
        const parts = content[1].trim().split(/\s+/); 
        
        if (parsedType !== 'gold' || parts.length < 2) return;

        type = parsedType;
        player = parts[0]; 
        value = parts[1];
        
        // Delete the original message to keep the Gold Channel clean, as we are re-posting it.
        message.delete().catch(e => console.error("Could not delete gold message:", e));
    } 
    // --- LOGIC FOR DAMAGE LOGS (Inside Forum Channel threads) ---
    else if (message.channel.parentId === DAMAGE_CATEGORY_ID) {
        // Damage format: Player posts value (e.g., "103T", "50 T") and a screenshot in their own thread.
        
        // 1. FILTERING: Must contain at least one attachment (screenshot) to be considered a log.
        const hasAttachment = message.attachments.size > 0;
        if (!hasAttachment) {
            // Ignore messages without a screenshot; these are likely discussion/spam.
            return;
        }

        type = 'damage';
        player = message.channel.name.trim(); // Player name is the thread title
        
        // --- MODIFIED: Handle the space between number and unit ---
        let rawValue = message.content.trim().split(/\s+/)[0]; 
        // Remove spaces (e.g., "50 T" -> "50T", "1.2 M" -> "1.2M")
        value = rawValue.replace(/\s/g, ''); 

        // 2. FILTERING: Basic checks to ensure a value was found after processing
        if (!value || player.length < 1) return;
        
        // Do NOT delete the damage message, as the screenshot needs to stay for audit purposes.
    }
    
    // If neither channel matched, exit
    if (!type) return;
    
    // --- CRITICAL STEP: SEND MESSAGE TO VERIFICATION CHANNEL ---

    const verificationChannel = await client.channels.fetch(VERIFICATION_CHANNEL_ID);
    if (!verificationChannel) {
        console.error("Verification channel not found!");
        return;
    }
    
    // Format the timestamp for Discord display (Discord requires seconds, not milliseconds)
    const discordTimestampFormat = `<t:${Math.floor(originalTimestampMs / 1000)}:f>`;

    let verificationMessageContent = 
        `**[${type.toUpperCase()}]** Log Submitted by **${message.author.username}**:\n` +
        `Player: \`${player}\`\n` +
        `Value: \`${value}\`\n` +
        `**Time Submitted:** ${discordTimestampFormat}\n` + // <-- ADDED SUBMISSION TIME
        `Source: ${sourceChannel.name} (<#${sourceChannel.id}>)\n` +
        `[Go to Original Message](${message.url})`;
        
    // --- NEW: Add the screenshot URL for damage logs if one exists ---
    if (type === 'damage' && message.channel.parentId === DAMAGE_CATEGORY_ID) {
        const attachment = message.attachments.first();
        if (attachment) {
            // Add the URL to the content. Discord will automatically create an embed/preview below the text.
            verificationMessageContent += `\n\n**-- Screenshot for Verification --**\n${attachment.url}`;
        }
    }

    try {
        const sentMessage = await verificationChannel.send({
            content: verificationMessageContent
        });
        
        // Store the data using the *new* verification message's ID as the key
        pendingVerifications.set(sentMessage.id, {
            type,
            player,
            value,
            originalTimestampMs // <-- TIMESTAMP STORED HERE
        });
        
        // React to the NEW message so admins can verify it easily
        await sentMessage.react('✅');
        
        console.log(`Log posted to verification channel for ${player} (${type}). Waiting for checkmark.`);

    } catch (error) {
        console.error('Failed to post or react to verification channel:', error);
    }
});


// --- 4. LISTENING FOR CHECKMARK REACTION (Only in the Central Channel) ---

client.on('messageReactionAdd', async (reaction, user) => {
    // Only process checkmarks and ignore bot's reactions
    if (reaction.emoji.name !== '✅' || user.bot) return;
    
    // --- CRITICAL: Only proceed if the reaction is in the central verification channel ---
    if (reaction.message.channelId !== VERIFICATION_CHANNEL_ID) return;

    // Fetch the message if partial
    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.error('Failed to fetch reaction message:', error);
            return;
        }
    }
    
    // Check if the message ID exists in our pending list
    if (pendingVerifications.has(reaction.message.id)) {
        
        const guild = reaction.message.guild;
        if (!guild) return;
        
        const member = await guild.members.fetch(user.id).catch(err => {
            console.error(`Could not fetch member ${user.id}: ${err.message}`);
            return null;
        });

        // --- MODIFIED: CHECK MULTIPLE ADMIN ROLES ---
        if (!member) return; 

        // Check if the member has ANY of the roles listed in ADMIN_ROLE_IDS
        const isAuthorized = ADMIN_ROLE_IDS.some(roleId => member.roles.cache.has(roleId));

        if (!isAuthorized) {
            console.log(`${user.tag} reacted but is not an authorized Admin. Ignoring.`);
            return; 
        }
        
        const entry = pendingVerifications.get(reaction.message.id);
        
        // Send the verified data to Google Sheets
        // PASS THE ORIGINAL TIMESTAMP TO THE WEBHOOK
        const success = await sendDataToSheets(entry, user.username, entry.originalTimestampMs);

        if (success) {
            // Remove from the pending list after successful submission
            pendingVerifications.delete(reaction.message.id);
            
            // Edit the message to show it was completed
            reaction.message.edit(`~~${reaction.message.content}~~ \n\n**✅ VERIFIED** by ${user.username}`).catch(console.error);
            
            // Remove all reactions (including the checkmark)
            reaction.message.reactions.removeAll().catch(console.error);
        }
    }
});

// --- 5. WEBHOOK SENDER (Slight modification for error reporting) ---

/**
 * Sends the verified data to the Google Apps Script Web App URL.
 * @param {Object} data The structured entry data (type, player, value).
 * @param {string} verifier The Discord username of the admin who added the checkmark.
 * @param {number} originalTimestampMs The timestamp of the original message submission.
 * @returns {boolean} True if the webhook was successful.
 */
async function sendDataToSheets(data, verifier, originalTimestampMs) {
    const payload = {
        type: data.type,
        player: data.player,
        value: data.value,
        verifier: verifier,
        originalTimestampMs: originalTimestampMs // <-- NEW DATA SENT TO GOOGLE SHEET
    };

    console.log(`Attempting to send verified data for ${data.player} (${data.type})...`);

    try {
        const response = await fetch(WEB_APP_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const resultText = await response.text();
        
        if (response.ok) {
            console.log(`✅ Sheets Success: ${resultText}`);
            return true;
        } else {
            console.error(`❌ Sheets Error: ${resultText}`);
            // Send a warning back to the central verification channel if the webhook fails
            const channel = await client.channels.fetch(VERIFICATION_CHANNEL_ID); 
            if (channel) {
                channel.send(`⚠️ **Verification Failed** for ${data.player} (${data.value}). Google Sheets returned an error: \`${resultText}\``);
            }
            return false;
        }
    } catch (error) {
        console.error('❌ Network Error while sending webhook:', error);
        return false;
    }
}


client.login(DISCORD_TOKEN);
