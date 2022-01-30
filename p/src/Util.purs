module Util where

import Prelude

import Control.Alt ((<|>))
import Control.Monad.Error.Class (class MonadThrow)
import Data.Array (head, filterA)
import Data.Either (Either(..), either)
import Data.Maybe (Maybe, maybe)
import Effect.Aff (Aff, Milliseconds, delay, error, parallel, sequential, throwError)

bool :: forall a. a -> a -> Boolean -> a
bool a _ false = a
bool _ a true = a

findM :: forall a m. Monad m => (a -> m Boolean) -> Array a -> m (Maybe a)
findM p xs =
  head <$> filterA p xs

fromMaybeErr :: forall a m e. MonadThrow e m => e -> Maybe a -> m a
fromMaybeErr e = maybe (throwError e) pure

par :: forall a. Aff a -> Aff a -> Aff a
par a b = sequential (parallel a <|> parallel b)

timeout :: forall a. Milliseconds -> Aff a -> Aff a
timeout t a = do
  either (const $ throwError (error "Timed out")) pure
    =<< par (Right <$> a) (Left <$> delay t)
