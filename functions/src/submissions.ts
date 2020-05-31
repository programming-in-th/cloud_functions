import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'
import { unzipCode, readCode, writeCode, isAdmin } from './util'
import * as crypto from 'crypto'

export const makeSubmission = functions
  .region('asia-east2')
  .https.onCall(
    async (requestData: any, context: functions.https.CallableContext) => {
      const { id, lang } = requestData
      let code = requestData.code
      const uid = context.auth?.uid

      if (context.auth === undefined) {
        throw new functions.https.HttpsError('unauthenticated', 'Please login')
      }

      if (!(typeof id === 'string') || id.length === 0) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'Problem ID must be a non-empty string'
        )
      }

      if (!(Array.isArray(code) || typeof code === 'string')) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'Code must be a non-empty Array of string'
        )
      }

      if (!(typeof lang === 'string') || lang.length === 0) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'Language must be a non-empty string'
        )
      }

      try {
        const taskDoc = await admin.firestore().doc(`tasks/${id}`).get()

        const task = taskDoc.data()

        if (!task) {
          throw new functions.https.HttpsError('data-loss', 'Task not found')
        }

        const taskID = taskDoc.id
        if (task.visible === true || isAdmin(context)) {
          if (typeof code === 'string') {
            code = await unzipCode(code, task.fileName)

            if (!Array.isArray(code)) {
              throw new functions.https.HttpsError(
                'invalid-argument',
                'Code must be in ZIP format or array'
              )
            }
          }

          const submissionID = (
            await admin.firestore().collection('submissions').add({
              taskID,
              language: lang,
              timestamp: admin.firestore.Timestamp.now(),
              uid,
            })
          ).id
          await writeCode(submissionID, code)
          return submissionID
        } else {
          throw new functions.https.HttpsError(
            'permission-denied',
            'Task Permission denied'
          )
        }
      } catch (error) {
        throw new functions.https.HttpsError('unknown', error)
      }
    }
  )

export const getSubmission = functions
  .region('asia-east2')
  .https.onCall(
    async (requestData: any, context: functions.https.CallableContext) => {
      const submissionID = requestData?.submissionID
      if (!(typeof submissionID === 'string') || submissionID.length === 0) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'Submission ID must be a non-empty string'
        )
      }

      try {
        const submissionDoc = await admin
          .firestore()
          .doc(`submissions/${submissionID}`)
          .get()
        const submission = submissionDoc.data()

        if (!submission) {
          throw new functions.https.HttpsError(
            'data-loss',
            'Submission not found'
          )
        }

        const taskID = submission.taskID
        const taskDoc = await admin.firestore().doc(`tasks/${taskID}`).get()

        const task = taskDoc.data()

        if (!task) {
          throw new functions.https.HttpsError('data-loss', 'Task not found')
        }
        task.id = taskDoc.id

        if (!(task.visible || isAdmin(context))) {
          return {}
        }
        const firebaseDate = new admin.firestore.Timestamp(
          submission.timestamp._seconds,
          submission.timestamp._nanoseconds
        )

        const humanTimestamp = firebaseDate.toDate().toLocaleString()

        const codelen = task.type === 'normal' ? 1 : task.fileName.length

        const code = await readCode(submissionID, codelen)

        const userDoc = await admin
          .firestore()
          .doc(`users/${submission.uid}`)
          .get()
        const user = userDoc.data()

        if (!user) {
          throw new functions.https.HttpsError('data-loss', 'User not found')
        }

        return {
          username: user.username,
          task,
          humanTimestamp,
          code,
        }
      } catch (error) {
        throw new functions.https.HttpsError('unknown', error)
      }
    }
  )

export const getSubmissions = functions
  .region('asia-east2')
  .https.onRequest(
    async (req: functions.https.Request, res: functions.Response) => {
      res.set('Access-Control-Allow-Origin', '*')

      try {
        let submissionRef = admin
          .firestore()
          .collection('submissions')
          .orderBy('timestamp', 'desc')

        if (req.query.username) {
          const userDocs = await admin
            .firestore()
            .collection('users')
            .where('username', '==', req.query.username)
            .get()

          if (userDocs.docs.length === 0) {
            res.send({ results: [], next: null })
            return
          }

          if (userDocs.docs.length !== 1) {
            const tmp: string[] = []
            for (const data of userDocs.docs) {
              tmp.push(data.id)
            }
            for (const data of tmp) {
              const tmpID = crypto.randomBytes(20).toString('hex')
              await admin
                .firestore()
                .doc(`users/${data}`)
                .update({ username: tmpID })
            }
            res.send({ results: [], next: null })
            return
          }

          const uid = userDocs.docs[0].id
          submissionRef = submissionRef.where('uid', '==', uid)
        }

        if (req.query.taskID) {
          const taskID = req.query.taskID
          submissionRef = submissionRef.where('taskID', '==', taskID)
        }

        let offset = 0
        let limit = 10

        if (req.query.limit) {
          limit = parseInt(req.query.limit as string)
        }

        if (req.query.offset) {
          offset = parseInt(req.query.offset as string)
        }

        const getSubmissionRef = submissionRef.offset(offset).limit(limit)
        const getSubmissionDocs = await getSubmissionRef.get()

        const temp: Object[] = []
        for (const doc of getSubmissionDocs.docs) {
          const data = doc.data()
          const userDoc = await admin.firestore().doc(`users/${data.uid}`).get()
          const user = userDoc.data()

          if (!user) {
            throw new functions.https.HttpsError('data-loss', 'User not found')
          }

          const taskDoc = await admin
            .firestore()
            .doc(`tasks/${data.taskID}`)
            .get()

          const task = taskDoc.data()

          if (!task) {
            throw new functions.https.HttpsError('data-loss', 'Task not found')
          }

          if (task.visible) {
            const firebaseDate = new admin.firestore.Timestamp(
              data.timestamp._seconds,
              data.timestamp._nanoseconds
            )
            const username = user.username
            const timestamp = data.timestamp
            const humanTimestamp = firebaseDate.toDate().toLocaleString()
            const language = data.language
            const taskID = taskDoc.id
            const submissionID = doc.id
            let score = 0,
              fullScore = 0,
              time = 0,
              memory = 0

            if (data.groups) {
              for (const group of data.groups) {
                score += group.score
                fullScore += group.fullScore
                for (const status of group.status) {
                  time = Math.max(time, status.time)
                  memory = Math.max(memory, status.memory)
                }
              }
            }

            temp.push({
              username,
              timestamp,
              humanTimestamp,
              language,
              score,
              fullScore,
              taskID,
              time,
              memory,
              submissionID,
            })
          } else {
            temp.push({})
          }
        }

        let next = null

        const checkSubmissionRef = submissionRef.offset(offset + limit).limit(1)
        const checkSubmissionDocs = await checkSubmissionRef.get()
        if (checkSubmissionDocs.docs.length !== 0) next = offset + limit
        res.send({ results: temp, next })
      } catch (error) {
        throw new functions.https.HttpsError('unknown', error)
      }
    }
  )
