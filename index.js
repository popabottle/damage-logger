const { Client, GatewayIntentBits, Partials } = require('discord.js');
const express = require('express');

// --- 1. CONFIGURATION AND INITIALIZATION ---

// Retrieve environment variables from Render Environment Variables
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID; 
const WEB_APP_URL = process.env.WEB_APP_URL;
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID; 

// Ensure all environment variables are set
if (!DISCORD_TOKEN || !ADMIN_CHANNEL_ID || !WEB_APP_URL || !ADMIN_ROLE_ID) {
    console.error("ERROR: One or more required environment variables (DISCORD_TOKEN, ADMIN_CHANNEL_ID, WEB_APP_URL, ADMIN_ROLE_ID) are missing.");
    process.exit(1);
}

// Initialize Discord Client with necessary intents for reactions and message content
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions // Required to monitor reactions
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction] // Required for reacting to messages not in cache
});

// A temporary place to store messages waiting for verification (Key: messageId)
// This will reset if the bot restarts, but is fine for simple verification flow.
const pendingVerifications = new Map();

// --- 2. BOT READY & SERVER STARTUP (For Render's health check) ---

client.on('ready', () => {
    console.log(`Bot logged in as ${client.user.tag}!`);
    // Start the server to handle Render's health checks
    startServer();
});


/**
 * Sets up a simple Express server to handle health checks and ensure the service stays running on Render.
 */
function startServer() {
    const app = express();
    // Render typically uses the PORT environment variable
    const port = process.env.PORT || 3000; 

    app.get('/', (req, res) => {
        // This is the endpoint Render will hit to check if the bot is alive
        res.send('Bot is awake and running!');
    });

    app.listen(port, () => {
        console.log(`Keep-Alive/Health Check Server listening on port ${port}.`);
    });
}

// --- 3. LISTENING FOR NEW ADMIN MESSAGES ---

client.on('messageCreate', async message => {
    // Only process messages in the specific Admin Verification Channel
    if (message.channelId !== ADMIN_CHANNEL_ID) return;
    
    // Ignore messages from the bot itself
    if (message.author.bot) return;

    // Expected format: [type]: [player] [value]
    // Example: "damage: Zeta 103T" or "gold: Ryu 500"
    const content = message.content.trim().split(':');
    
    if (content.length < 2) {
        // Optionally inform the admin if the format is wrong
        // message.reply('Please use the format: type: player value');
        console.log(`Message skipped: Incorrect format. Content: ${message.content}`);
        return;
    }

    const type = content[0].trim().toLowerCase(); // 'damage' or 'gold'
    const parts = content[1].trim().split(/\s+/); // Splits by any whitespace
    
    if (parts.length < 2) {
        console.log(`Message skipped: Missing player or value. Content: ${message.content}`);
        return;
    }
    
    const player = parts[0];
    const value = parts[1];
    
    if (type === 'damage' || type === 'gold') {
        // Store the verification details
        pendingVerifications.set(message.id, {
            type,
            player,
            value
        });
        
        // React with the checkmark to signal it's ready for verification
        try {
            await message.react('✅');
            console.log(`Set up pending verification for ${player} (${type}). Waiting for checkmark.`);
        } catch (error) {
            console.error('Failed to react with checkmark:', error);
        }
    }
});


// --- 4. LISTENING FOR CHECKMARK REACTION ---

client.on('messageReactionAdd', async (reaction, user) => {
    // Check if the reaction is the checkmark emoji and it's not the bot
    if (reaction.emoji.name !== '✅' || user.bot) return;

    // Fetch the full message data if it's not cached
    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.error('Failed to fetch reaction message:', error);
            return;
        }
    }

    // Check if the message is in the Admin Verification Channel
    if (reaction.message.channelId !== ADMIN_CHANNEL_ID) return;

    // Find the message's ID in our pending list
    if (pendingVerifications.has(reaction.message.id)) {
        
        const guild = reaction.message.guild;
        
        // Ensure we are inside a guild context
        if (!guild) return;
        
        // Fetch the guild member to check roles
        const member = await guild.members.fetch(user.id).catch(err => {
            console.error(`Could not fetch member ${user.id}: ${err.message}`);
            return null;
        });

        // --- CHECK ADMIN ROLE ---
        // Verify the user who reacted has the required Admin Role ID
        if (!member || !member.roles.cache.has(ADMIN_ROLE_ID)) {
            console.log(`${user.tag} reacted but is not an authorized Admin. Ignoring.`);
            return; // Stop if the user is not an admin
        }
        
        const entry = pendingVerifications.get(reaction.message.id);
        
        // Send the verified data to Google Sheets
        const success = await sendDataToSheets(entry, user.username);

        if (success) {
            // Remove from the pending list after successful submission
            pendingVerifications.delete(reaction.message.id);
            // Optionally remove the checkmark reaction to clean up the channel
            reaction.remove().catch(console.error); 
        }
    }
});

// --- 5. WEBHOOK SENDER ---

/**
 * Sends the verified data to the Google Apps Script Web App URL.
 * @param {Object} data The structured entry data (type, player, value).
 * @param {string} verifier The Discord username of the admin who added the checkmark.
 * @returns {boolean} True if the webhook was successful.
 */
async function sendDataToSheets(data, verifier) {
    const payload = {
        type: data.type,
        player: data.player,
        value: data.value,
        verifier: verifier 
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
            // Send a warning back to Discord if the webhook fails
            const channel = await client.channels.fetch(ADMIN_CHANNEL_ID);
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
