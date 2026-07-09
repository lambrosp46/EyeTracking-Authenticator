import React from 'react';

export async function createUser({ username, imageUri }) {
    const user = {
        username,
        imageUri,
        createdAt: new Date().toISOString(),
    };

    return user;
}