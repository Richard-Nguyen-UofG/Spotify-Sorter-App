// Hardcoding to exactly match the Spotify Dashboard configuration
export const REDIRECT_URI = "https://127.0.0.1:8888";

export async function redirectToAuthCodeFlow(clientId) {
    const verifier = generateRandomString(128);
    const challenge = await generateCodeChallenge(verifier);

    localStorage.setItem("verifier", verifier);

    const params = new URLSearchParams();
    params.append("client_id", clientId);
    params.append("response_type", "code");
    params.append("redirect_uri", REDIRECT_URI);
    params.append("scope", "user-read-private playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private");
    params.append("code_challenge_method", "S256");
    params.append("code_challenge", challenge);

    document.location = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

function generateRandomString(length) {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

async function generateCodeChallenge(codeVerifier) {
    const data = new TextEncoder().encode(codeVerifier);
    const digest = await window.crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode.apply(null, [...new Uint8Array(digest)]))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

export async function getAccessToken(clientId, code) {
    const verifier = localStorage.getItem("verifier");

    const params = new URLSearchParams();
    params.append("client_id", clientId);
    params.append("grant_type", "authorization_code");
    params.append("code", code);
    params.append("redirect_uri", REDIRECT_URI);
    params.append("code_verifier", verifier);

    const result = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params
    });

    const data = await result.json();
    if (data.access_token) {
        setToken(data.access_token, data.expires_in);
        if (data.refresh_token) {
            localStorage.setItem('spotify_refresh_token', data.refresh_token);
        }
        return data.access_token;
    }
    throw new Error(data.error_description || "Failed to exchange authorization code for access token.");
}

export async function refreshAccessToken(clientId) {
    const refreshToken = localStorage.getItem('spotify_refresh_token');
    if (!refreshToken) return null;

    const params = new URLSearchParams();
    params.append("client_id", clientId || import.meta.env.VITE_SPOTIFY_CLIENT_ID);
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", refreshToken);

    const result = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params
    });

    if (!result.ok) {
        console.warn("Could not refresh token automatically:", await result.text());
        return null;
    }

    const data = await result.json();
    if (data.access_token) {
        setToken(data.access_token, data.expires_in);
        if (data.refresh_token) {
            localStorage.setItem('spotify_refresh_token', data.refresh_token);
        }
        return data.access_token;
    }
    return null;
}

export const setToken = (token, expiresInSeconds = 3600) => {
    window.localStorage.setItem('spotify_token', token);
    const expiresAt = Date.now() + (expiresInSeconds * 1000);
    window.localStorage.setItem('spotify_token_expires_at', String(expiresAt));
};

export const getToken = () => {
    return window.localStorage.getItem('spotify_token');
};

export const isTokenExpired = () => {
    const expiresAt = window.localStorage.getItem('spotify_token_expires_at');
    if (!expiresAt) return false;
    // Buffer of 60 seconds
    return Date.now() > (parseInt(expiresAt, 10) - 60000);
};

export const removeToken = () => {
    window.localStorage.removeItem('spotify_token');
    window.localStorage.removeItem('spotify_refresh_token');
    window.localStorage.removeItem('spotify_token_expires_at');
    window.localStorage.removeItem('verifier');
};
