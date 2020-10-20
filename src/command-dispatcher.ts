// Copyright (C) 2019-2020 CCDirectLink members
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import * as discord from 'discord.js';
import * as commando from 'discord.js-commando';
import {CCBot} from './ccbot';
import {mentionRegex} from './utils';

// Not nice.
// dmitmel: First of all, how is it possible that "nice" is written here with no signs of Emi around?
// Secondly, this injection (what am I saying, this isn't CrossCode...) is done because as 20kdc said
// "the TypeScript definitions for Commando are broken". See, in the definitions the class CommandDispatcher
// is not only declared, but also exported in the namespace, which is not the case on the JS side of
// things, thus this statement "fixes" Commando's definitions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(commando as any).CommandDispatcher = require('discord.js-commando/src/dispatcher');

declare module 'discord.js-commando' {
    interface CommandoMessage {
        initCommand(command: commando.Command, argString: string, patternMatches?: string[]): this;
    }
}

// NOTE: Here's how you make the TS compiler shut up about overriding and calling private methods:
//
// class A {
//     private f1(): void {
//         console.log('A#f1');
//     }
// }
//
// class B extends A {
//     private ['f1' as string](): void {
//         console.log('B#f1');
//         super['f1']();
//     }
// }

async function cleanupMessage(client: CCBot, message: discord.Message): Promise<void> {
    client.entities.killEntity(`message-${message.id}`, true);
    for (const r of message.reactions.cache.values())
        if (r.me)
            await r.users.remove();
}

/// A modified version of initCommand that patches CommandoMessage in order to perform better cleanup.
function initCCBotCommandoMessage(
    message: discord.Message,
    command: commando.Command,
    argString: string,
    patternMatches?: string[]
): commando.CommandoMessage {
    // Why the heck doesn't the commando.CommandoMessage class inherit discord.Message in the type
    // definitions??? Why the heck isn't the method initCommand defined???
    const self = (message as unknown as commando.CommandoMessage).initCommand(command, argString, patternMatches);

    // Might as well just fork Commando and make proper definitions myself where CommandoMessage extends Message.
    self.message = message;

    /// Prepares to edit a response.
    /// This modified version cleans up after whatever was happening before.
    // eslint-disable-next-line dot-notation
    self['editResponse'] = async function editResponse(a: (discord.Message | discord.Message[]), b?: { options: discord.MessageOptions }): Promise<discord.Message | discord.Message[]> {
        // Kill involved entities
        if (Array.isArray(a)) {
            for (const msg of a)
                await cleanupMessage(this.client as CCBot, msg);
        } else {
            await cleanupMessage(this.client as CCBot, a);
        }
        // Get rid of embed
        if (b) {
            if (b.options) {
                if (!b.options.embed)
                    b.options.embed = undefined;
            } else {
                b.options = {embed: undefined};
            }
        }
        // eslint-disable-next-line dot-notation
        return commando.CommandoMessage.prototype['editResponse'].call(this, a, b);
    };

    return self;
}

/// A modified version of the CommandDispatcher to apply custom parsing rules and the new CommandoMessage.
export default class CCBotCommandDispatcher extends commando.CommandDispatcher {
    public readonly client!: CCBot;

    public constructor(c: CCBot, r: commando.CommandoRegistry) {
        super(c, r);
    }

    private ['parseMessage' as string](message: discord.Message): commando.CommandoMessage | null {
        // Stage 1: Prefix removal, cleanup
        let text: string = message.content;

        // The regexes used here are taken from the older code.

        // Trim
        text = text.replace(/^\s+|\s+$/g, '');

        //  Get & remove the prefix
        let commandPrefix: string | undefined;
        if (message.guild) {
            commandPrefix = message.guild.commandPrefix;
        } else {
            commandPrefix = this.client.commandPrefix;
        }

        // TODO: rewrite this to use an array of prefixes
        const commandPrefixMention1 = `<@!${this.client.user!.id}>`;
        const commandPrefixMention2 = `<@${this.client.user!.id}>`;

        if (commandPrefix && text.startsWith(commandPrefix)) {
            text = text.substring(commandPrefix.length);
        } else if (text.startsWith(commandPrefixMention1)) {
            text = text.substring(commandPrefixMention1.length);
        } else if (text.startsWith(commandPrefixMention2)) {
            text = text.substring(commandPrefixMention2.length);
        } else if (!message.guild) {
            text = text; // eslint-disable-line no-self-assign
        } else {
            return null;
        }

        // Stage 2: Further Stuff

        // Remove mentions, but keep the content so they work properly for findCheaterByRef
        text = text.replace(mentionRegex, '$1');
        // Trim (again!)
        text = text.replace(/^\s+|\s+$/g, '');

        // Stage 3: Parse The Command
        let group = 'general';
        if (text.startsWith('-')) {
            const cutPoint1 = text.indexOf(' ');
            if (cutPoint1 != -1) {
                group = text.substring(1, cutPoint1);
                text = text.substring(cutPoint1);
                // Trim (once more)
                text = text.replace(/^\s+|\s+$/g, '');
            }
        }
        let command = text;
        const cutPoint2 = text.indexOf(' ');
        if (cutPoint2 != -1) {
            command = text.substring(0, cutPoint2);
            text = text.substring(cutPoint2);
            // Trim (yet again)
            text = text.replace(/^\s+|\s+$/g, '');
        } else {
            text = '';
        }

        // console.log([group, command, text]);

        // Stage 4: Actually Figure Out What Command It Is

        group = group.toLowerCase();
        command = command.toLowerCase();

        const groupInst: commando.CommandGroup | undefined = this.registry.groups.get(group);
        if (!groupInst)
            return this.parseUnknownCommand(message, text);

        // So much simpler via 'memberName', command: but that's "deprecated" for some silly reason
        const commandInst: commando.Command | undefined = groupInst.commands.find((cmd: commando.Command): boolean => {
            return cmd.memberName == command;
        });
        if (!commandInst)
            return this.parseUnknownCommand(message, text);

        return initCCBotCommandoMessage(message, commandInst, text);
    }

    private parseUnknownCommand(message: discord.Message, text: string): commando.CommandoMessage | null {
        // This is imitating the Commando master behavior.
        // But we use it as a method for overriding the unknown-command.
        let cmd: commando.Command | undefined;
        const utilGroup: commando.CommandGroup | undefined = this.registry.groups.get('util');
        if (utilGroup)
            cmd = utilGroup.commands.find((cmd: commando.Command): boolean => {
                return cmd.memberName == 'unknown-command';
            });
        if (!cmd)
            return null;
        return initCCBotCommandoMessage(message, cmd, text);
    }
}
