import { ObjectId } from 'mongodb'
import { Db, Collection } from 'mongodb'

export interface Message {
  _id?: ObjectId
  senderId: ObjectId
  senderName?: string
  content: string
  isSystem: boolean
  createdAt: Date
}

export const getMessageCollection = (db: Db): Collection<Message> => {
  return db.collection<Message>('messages')
}
