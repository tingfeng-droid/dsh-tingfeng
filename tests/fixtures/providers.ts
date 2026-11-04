import { descriptor as native } from 'dsh-tingfeng-provider-mnemon-native'
import { descriptor as openviking } from 'dsh-tingfeng-provider-openviking'
import { descriptor as holographic } from 'dsh-tingfeng-provider-holographic'
import { descriptor as honcho } from 'dsh-tingfeng-provider-honcho'
import { descriptor as mem0 } from 'dsh-tingfeng-provider-mem0'
import { descriptor as hindsight } from 'dsh-tingfeng-provider-hindsight'
import { descriptor as retaindb } from 'dsh-tingfeng-provider-retaindb'
import { descriptor as byterover } from 'dsh-tingfeng-provider-byterover'
import { descriptor as supermemory } from 'dsh-tingfeng-provider-supermemory'

/** Explicit test assembly, never a production built-in Provider registry. */
export const TEST_PROVIDERS = [native, openviking, holographic, honcho, mem0, hindsight, retaindb, byterover, supermemory]
